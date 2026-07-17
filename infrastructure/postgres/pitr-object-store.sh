#!/bin/sh
# Shared fail-closed S3-compatible object-store setup for PostgreSQL PITR scripts.
set -eu

pitr_fail() {
  echo "ERROR: $*" >&2
  exit 1
}

pitr_is_positive_integer() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) [ "$1" -ge 1 ] ;;
  esac
}

pitr_is_bounded_positive_integer() {
  pitr_value="$1"
  pitr_maximum="$2"
  pitr_is_positive_integer "${pitr_value}" && [ "${pitr_value}" -le "${pitr_maximum}" ]
}

pitr_owner_cgroup_v2_create() {
  awk '$5 == "/sys/fs/cgroup" && $0 ~ / - cgroup2 / { found=1 } END { exit !found }' /proc/self/mountinfo 2>/dev/null \
    || { echo "ERROR: PITR provider ownership requires cgroup v2 mounted at /sys/fs/cgroup." >&2; return 1; }
  pitr_owner_cgroup_path="$(sed -n 's/^0:://p' /proc/self/cgroup)"
  case "${pitr_owner_cgroup_path}" in /*) ;; *) echo "ERROR: PITR provider ownership could not resolve the current cgroup v2 path." >&2; return 1 ;; esac
  pitr_owner_cgroup_parent="/sys/fs/cgroup${pitr_owner_cgroup_path}"
  pitr_owner_cgroup_domain="$(mktemp -d "${pitr_owner_cgroup_parent%/}/lunchlineup-pitr-provider.XXXXXX" 2>/dev/null)" \
    || { echo "ERROR: PITR provider ownership requires a writable delegated cgroup v2 beneath ${pitr_owner_cgroup_parent}." >&2; return 1; }
  if [ ! -w "${pitr_owner_cgroup_domain}/cgroup.procs" ] \
    || [ ! -w "${pitr_owner_cgroup_domain}/cgroup.kill" ] \
    || ! grep -q '^populated 0$' "${pitr_owner_cgroup_domain}/cgroup.events" 2>/dev/null
  then
    rmdir "${pitr_owner_cgroup_domain}" 2>/dev/null || true
    echo "ERROR: PITR provider ownership requires delegated cgroup.procs, cgroup.kill, and cgroup.events controls." >&2
    return 1
  fi
  printf '%s' "${pitr_owner_cgroup_domain}"
}

pitr_owner_cgroup_v2_populated() {
  grep -q '^populated 1$' "$1/cgroup.events" 2>/dev/null
}

pitr_owner_cgroup_v2_empty() {
  grep -q '^populated 0$' "$1/cgroup.events" 2>/dev/null \
    && [ -z "$(cat "$1/cgroup.procs" 2>/dev/null)" ] \
    && grep -q '^populated 0$' "$1/cgroup.events" 2>/dev/null
}

pitr_owner_cgroup_v2_signal() {
  pitr_owner_signal_domain="$1"
  pitr_owner_signal_name="$2"
  while IFS= read -r pitr_owner_signal_pid; do
    [ -z "${pitr_owner_signal_pid}" ] || kill "-${pitr_owner_signal_name}" "${pitr_owner_signal_pid}" 2>/dev/null || true
  done <"${pitr_owner_signal_domain}/cgroup.procs"
}

pitr_owner_cgroup_v2_terminate() {
  pitr_owner_terminate_domain="$1"
  pitr_owner_terminate_kill_after="$2"
  pitr_owner_empty_checks=0
  pitr_owner_cgroup_v2_signal "${pitr_owner_terminate_domain}" TERM
  sleep "${pitr_owner_terminate_kill_after}"
  if pitr_owner_cgroup_v2_populated "${pitr_owner_terminate_domain}"; then
    printf '1\n' >"${pitr_owner_terminate_domain}/cgroup.kill" \
      || { echo "ERROR: Could not KILL the complete PITR provider cgroup v2 ownership domain." >&2; return 1; }
  fi
  while ! pitr_owner_cgroup_v2_empty "${pitr_owner_terminate_domain}"; do
    pitr_owner_empty_checks=$((pitr_owner_empty_checks + 1))
    [ "${pitr_owner_empty_checks}" -le 100 ] \
      || { echo "ERROR: PITR provider cgroup v2 ownership domain did not become empty after KILL." >&2; return 1; }
    sleep 0.05
  done
}

pitr_owner_cgroup_v2_wait_stopped() {
  pitr_owner_wait_pid="$1"
  pitr_owner_wait_checks=0
  while [ "${pitr_owner_wait_checks}" -le 200 ]; do
    [ -r "/proc/${pitr_owner_wait_pid}/status" ] || return 1
    pitr_owner_wait_state="$(sed -n 's/^State:[[:space:]]*\([A-Za-z]\).*/\1/p' "/proc/${pitr_owner_wait_pid}/status")"
    [ "${pitr_owner_wait_state}" != T ] || return 0
    pitr_owner_wait_checks=$((pitr_owner_wait_checks + 1))
    sleep 0.01
  done
  return 1
}

pitr_owner_process_snapshot() {
  for pitr_owner_process_dir in /proc/[0-9]*; do
    [ -r "${pitr_owner_process_dir}/status" ] || continue
    printf '%s\n' "${pitr_owner_process_dir##*/}"
  done
}

pitr_owner_container_job_survivors() {
  pitr_owner_baseline_file="$1"
  pitr_owner_survivors=""
  for pitr_owner_process_dir in /proc/[0-9]*; do
    [ -r "${pitr_owner_process_dir}/status" ] || continue
    pitr_owner_process_pid="${pitr_owner_process_dir##*/}"
    if ! grep -Fxq "${pitr_owner_process_pid}" "${pitr_owner_baseline_file}"; then
      pitr_owner_survivors="${pitr_owner_survivors}${pitr_owner_survivors:+ }${pitr_owner_process_pid}"
    fi
  done
  [ -z "${pitr_owner_survivors}" ]
}

pitr_json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

pitr_read_secret() {
  pitr_secret_path="$1"
  pitr_secret_label="$2"
  pitr_secret_value="$(cat "${pitr_secret_path}")"
  [ -n "${pitr_secret_value}" ] || pitr_fail "${pitr_secret_label} is empty."
  if printf '%s' "${pitr_secret_value}" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    pitr_fail "${pitr_secret_label} must not contain control characters."
  fi
  printf '%s' "${pitr_secret_value}"
}

pitr_archive_kind() {
  archive_name="$1"
  if printf '%s\n' "${archive_name}" | grep -Eq '^[0-9A-F]{24}$'; then
    printf '%s\n' wal
  elif printf '%s\n' "${archive_name}" | grep -Eq '^[0-9A-F]{8}\.history$'; then
    printf '%s\n' history
  elif printf '%s\n' "${archive_name}" | grep -Eq '^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$'; then
    printf '%s\n' backup
  else
    return 1
  fi
}

pitr_validate_object_store() {
  [ "${PITR_ENABLED:-false}" = "true" ] || pitr_fail "PITR_ENABLED must be true."

  case "${PITR_S3_ENDPOINT:-}" in
    https://*) ;;
    http://*) [ "${PITR_ALLOW_INSECURE_ENDPOINT:-false}" = "true" ] || pitr_fail "PITR_S3_ENDPOINT must use HTTPS." ;;
    *) pitr_fail "PITR_S3_ENDPOINT must be an explicit HTTPS S3-compatible endpoint." ;;
  esac

  case "${PITR_S3_BUCKET:-}" in
    '' | *[!a-z0-9.-]* | .* | *.) pitr_fail "PITR_S3_BUCKET must be a valid explicit bucket name." ;;
  esac
  case "${PITR_S3_PREFIX:-}" in
    '' | /* | */ | *..* | *//* | *[!A-Za-z0-9._/-]*) pitr_fail "PITR_S3_PREFIX must be a dedicated cluster prefix." ;;
  esac

  PITR_MC_BIN="${PITR_MC_BIN:-/opt/lunchlineup/tools/mc}"
  PITR_MC_TIMEOUT_SECONDS="${PITR_MC_TIMEOUT_SECONDS:-120}"
  PITR_MC_KILL_AFTER_SECONDS="${PITR_MC_KILL_AFTER_SECONDS:-5}"
  PITR_PROVIDER_OWNERSHIP_MODE="${PITR_PROVIDER_OWNERSHIP_MODE:-cgroup-v2}"
  PITR_OBJECT_LOCK_RETENTION_DAYS="${PITR_OBJECT_LOCK_RETENTION_DAYS:-}"
  PITR_ACCESS_KEY_FILE="${PITR_ACCESS_KEY_FILE:-}"
  PITR_SECRET_KEY_FILE="${PITR_SECRET_KEY_FILE:-}"
  pitr_is_positive_integer "${PITR_OBJECT_LOCK_RETENTION_DAYS}" \
    || pitr_fail "PITR_OBJECT_LOCK_RETENTION_DAYS must be a positive integer."
  pitr_is_bounded_positive_integer "${PITR_MC_TIMEOUT_SECONDS}" 3600 \
    || pitr_fail "PITR_MC_TIMEOUT_SECONDS must be an integer from 1 through 3600."
  pitr_is_bounded_positive_integer "${PITR_MC_KILL_AFTER_SECONDS}" 60 \
    || pitr_fail "PITR_MC_KILL_AFTER_SECONDS must be an integer from 1 through 60."
  case "${PITR_PROVIDER_OWNERSHIP_MODE}" in
    cgroup-v2 | container-job) ;;
    *) pitr_fail "PITR_PROVIDER_OWNERSHIP_MODE must be cgroup-v2 or container-job." ;;
  esac
  command -v timeout >/dev/null 2>&1 || pitr_fail "Required command is missing: timeout"
  [ -x "${PITR_MC_BIN}" ] || pitr_fail "PITR object-store client is not executable: ${PITR_MC_BIN}"
  [ -s "${PITR_ACCESS_KEY_FILE}" ] || pitr_fail "PITR access-key secret is missing."
  [ -s "${PITR_SECRET_KEY_FILE}" ] || pitr_fail "PITR secret-key secret is missing."
}

pitr_open_object_store() {
  pitr_validate_object_store
  pitr_previous_umask="$(umask)"
  umask 077
  PITR_MC_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-pitr-mc.XXXXXX")"
  PITR_MC_CONFIG_FILE="${PITR_MC_CONFIG_DIR}/config.json"
  PITR_ACCESS_KEY="$(pitr_read_secret "${PITR_ACCESS_KEY_FILE}" 'PITR access-key secret')"
  PITR_SECRET_KEY="$(pitr_read_secret "${PITR_SECRET_KEY_FILE}" 'PITR secret-key secret')"
  PITR_ENDPOINT_JSON="$(pitr_json_escape "${PITR_S3_ENDPOINT}")"
  PITR_ACCESS_KEY_JSON="$(pitr_json_escape "${PITR_ACCESS_KEY}")"
  PITR_SECRET_KEY_JSON="$(pitr_json_escape "${PITR_SECRET_KEY}")"
  printf '%s\n' \
    '{' \
    '  "version": "10",' \
    '  "aliases": {' \
    "    \"pitr\": {\"url\": \"${PITR_ENDPOINT_JSON}\", \"accessKey\": \"${PITR_ACCESS_KEY_JSON}\", \"secretKey\": \"${PITR_SECRET_KEY_JSON}\", \"api\": \"S3v4\", \"path\": \"auto\"}" \
    '  }' \
    '}' >"${PITR_MC_CONFIG_FILE}"
  chmod 0600 "${PITR_MC_CONFIG_FILE}"
  unset PITR_ACCESS_KEY PITR_SECRET_KEY PITR_ENDPOINT_JSON PITR_ACCESS_KEY_JSON PITR_SECRET_KEY_JSON
  umask "${pitr_previous_umask}"
  unset pitr_previous_umask
  PITR_REMOTE_ROOT="pitr/${PITR_S3_BUCKET}/${PITR_S3_PREFIX}"
}

pitr_close_object_store() {
  if [ -n "${PITR_MC_CONFIG_DIR:-}" ]; then
    rm -rf "${PITR_MC_CONFIG_DIR}"
    PITR_MC_CONFIG_DIR=""
  fi
}

pitr_mc() {
  if [ "${PITR_PROVIDER_OWNERSHIP_MODE:-cgroup-v2}" = "container-job" ]; then
    pitr_mc_baseline="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-pitr-provider-baseline.XXXXXX")"
    pitr_owner_process_snapshot >"${pitr_mc_baseline}"
    timeout \
      --signal=TERM \
      --kill-after="${PITR_MC_KILL_AFTER_SECONDS}s" \
      "${PITR_MC_TIMEOUT_SECONDS}s" \
      "${PITR_MC_BIN}" --config-dir "${PITR_MC_CONFIG_DIR}" "$@" &
    pitr_mc_pid=$!
    if wait "${pitr_mc_pid}"; then
      pitr_mc_status=0
    else
      pitr_mc_status=$?
    fi
    if ! pitr_owner_container_job_survivors "${pitr_mc_baseline}"; then
      rm -f "${pitr_mc_baseline}"
      echo "ERROR: PITR provider command left descendant processes; aborting the request-scoped container ownership domain (pids=${pitr_owner_survivors})." >&2
      exit 70
    fi
    rm -f "${pitr_mc_baseline}"
    if [ "${pitr_mc_status}" -eq 124 ] || [ "${pitr_mc_status}" -eq 137 ]; then
      echo "ERROR: PITR object-store command timed out after ${PITR_MC_TIMEOUT_SECONDS}s; the request-scoped container will terminate before retry and provider state is unknown." >&2
    fi
    return "${pitr_mc_status}"
  fi

  pitr_mc_cgroup="$(pitr_owner_cgroup_v2_create)" \
    || pitr_fail "PITR object-store command was not started because no safe descendant ownership domain is available."
  sh -c 'kill -STOP "$$"; exec "$@"' lunchlineup-pitr-provider-owner \
    timeout \
    --signal=TERM \
    --kill-after="${PITR_MC_KILL_AFTER_SECONDS}s" \
    "${PITR_MC_TIMEOUT_SECONDS}s" \
    "${PITR_MC_BIN}" --config-dir "${PITR_MC_CONFIG_DIR}" "$@" &
  pitr_mc_pid=$!
  if ! pitr_owner_cgroup_v2_wait_stopped "${pitr_mc_pid}" \
    || ! printf '%s\n' "${pitr_mc_pid}" >"${pitr_mc_cgroup}/cgroup.procs" \
    || ! grep -Fxq "${pitr_mc_pid}" "${pitr_mc_cgroup}/cgroup.procs"
  then
    kill -KILL "${pitr_mc_pid}" 2>/dev/null || true
    wait "${pitr_mc_pid}" 2>/dev/null || true
    rmdir "${pitr_mc_cgroup}" 2>/dev/null || true
    pitr_fail "PITR object-store command was not started because cgroup v2 ownership could not be established atomically."
  fi
  if ! kill -CONT "${pitr_mc_pid}"; then
    kill -KILL "${pitr_mc_pid}" 2>/dev/null || true
    wait "${pitr_mc_pid}" 2>/dev/null || true
    rmdir "${pitr_mc_cgroup}" 2>/dev/null || true
    pitr_fail "PITR object-store command was not started because its cgroup v2 owner could not release the launch barrier."
  fi
  if wait "${pitr_mc_pid}"; then
    pitr_mc_status=0
  else
    pitr_mc_status=$?
  fi
  pitr_mc_had_survivors=false
  if pitr_owner_cgroup_v2_populated "${pitr_mc_cgroup}"; then
    pitr_mc_had_survivors=true
    pitr_owner_cgroup_v2_terminate "${pitr_mc_cgroup}" "${PITR_MC_KILL_AFTER_SECONDS}" \
      || pitr_fail "PITR provider ownership domain could not be proven empty; output cleanup is unsafe."
  fi
  pitr_owner_cgroup_v2_empty "${pitr_mc_cgroup}" \
    || pitr_fail "PITR provider ownership domain is not empty after bounded termination."
  rmdir "${pitr_mc_cgroup}" \
    || pitr_fail "PITR provider ownership domain could not be removed after empty proof."
  if [ "${pitr_mc_had_survivors}" = true ] && [ "${pitr_mc_status}" -eq 0 ]; then
    pitr_mc_status=70
    echo "ERROR: PITR object-store command exited with live descendants; the complete ownership domain was terminated and provider state is unknown." >&2
  fi
  if [ "${pitr_mc_status}" -eq 124 ] || [ "${pitr_mc_status}" -eq 137 ]; then
    echo "ERROR: PITR object-store command timed out after ${PITR_MC_TIMEOUT_SECONDS}s; its cgroup v2 ownership domain was TERM-then-KILL bounded after ${PITR_MC_KILL_AFTER_SECONDS}s and proven empty; provider state is unknown." >&2
  fi
  return "${pitr_mc_status}"
}

pitr_json_version_id() {
  sed -n 's/.*"versionI[Dd]"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

pitr_remote_stat_json() {
  pitr_stat_target="$1"
  pitr_stat_output="$2"
  pitr_stat_version="${3:-}"
  pitr_stat_error="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-pitr-stat.XXXXXX")"
  if [ -n "${pitr_stat_version}" ]; then
    if pitr_mc --json stat --version-id "${pitr_stat_version}" "${pitr_stat_target}" >"${pitr_stat_output}" 2>"${pitr_stat_error}"; then
      pitr_stat_status=0
    else
      pitr_stat_status=$?
    fi
  elif pitr_mc --json stat "${pitr_stat_target}" >"${pitr_stat_output}" 2>"${pitr_stat_error}"; then
    pitr_stat_status=0
  else
    pitr_stat_status=$?
  fi
  if [ "${pitr_stat_status}" -eq 0 ]; then
    rm -f "${pitr_stat_error}"
    [ -s "${pitr_stat_output}" ] || pitr_fail "PITR provider stat returned empty metadata for ${pitr_stat_target}."
    return 0
  fi
  if grep -Eqi 'NoSuchKey|NoSuchObject|not found|status code: 404|\b404\b' "${pitr_stat_error}"; then
    rm -f "${pitr_stat_error}"
    return 1
  fi
  cat "${pitr_stat_error}" >&2 || true
  rm -f "${pitr_stat_error}"
  pitr_fail "PITR provider stat state is unknown for ${pitr_stat_target}; refusing mutation or restore."
}

pitr_exact_stat_version() {
  pitr_exact_target="$1"
  pitr_exact_requested_version="${2:-}"
  pitr_exact_stat="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-pitr-stat-json.XXXXXX")"
  if ! pitr_remote_stat_json "${pitr_exact_target}" "${pitr_exact_stat}" "${pitr_exact_requested_version}"; then
    rm -f "${pitr_exact_stat}"
    return 1
  fi
  pitr_exact_version="$(pitr_json_version_id "${pitr_exact_stat}")"
  rm -f "${pitr_exact_stat}"
  case "${pitr_exact_version}" in '' | null | latest) pitr_fail "PITR provider stat did not return an immutable version ID for ${pitr_exact_target}." ;; esac
  if [ -n "${pitr_exact_requested_version}" ] && [ "${pitr_exact_version}" != "${pitr_exact_requested_version}" ]; then
    pitr_fail "PITR provider stat returned a different object version for ${pitr_exact_target}."
  fi
  printf '%s' "${pitr_exact_version}"
}

pitr_resolve_single_version() {
  pitr_single_target="$1"
  pitr_versions_file="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-pitr-versions.XXXXXX")"
  pitr_versions_values="${pitr_versions_file}.values"
  if ! pitr_mc --json ls --versions "${pitr_single_target}" >"${pitr_versions_file}"; then
    rm -f "${pitr_versions_file}" "${pitr_versions_values}"
    pitr_fail "Could not enumerate immutable versions for ${pitr_single_target}."
  fi
  sed -n 's/.*"versionI[Dd]"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${pitr_versions_file}" \
    | grep -Ev '^(null|latest)?$' >"${pitr_versions_values}" || true
  pitr_version_count="$(wc -l <"${pitr_versions_values}" | tr -d ' ')"
  if [ "${pitr_version_count}" -ne 1 ] || grep -Eqi '"deleteMarker"[[:space:]]*:[[:space:]]*true' "${pitr_versions_file}"; then
    rm -f "${pitr_versions_file}" "${pitr_versions_values}"
    pitr_fail "PITR object has missing, conflicting, unversioned, or delete-marker history: ${pitr_single_target}."
  fi
  pitr_single_version="$(head -n 1 "${pitr_versions_values}")"
  rm -f "${pitr_versions_file}" "${pitr_versions_values}"
  printf '%s' "${pitr_single_version}"
}

pitr_download_version() {
  pitr_download_target="$1"
  pitr_download_version="$2"
  pitr_download_output="$3"
  case "${pitr_download_version}" in '' | null | latest | *[!A-Za-z0-9._+=:/-]*) pitr_fail "PITR restore requires one exact provider version ID." ;; esac
  pitr_exact_stat_version "${pitr_download_target}" "${pitr_download_version}" >/dev/null
  pitr_mc cp --version-id "${pitr_download_version}" "${pitr_download_target}" "${pitr_download_output}" >/dev/null
  [ -s "${pitr_download_output}" ] || pitr_fail "PITR provider returned an empty versioned object: ${pitr_download_target}."
}

pitr_download_single_version() {
  pitr_download_single_target="$1"
  pitr_download_single_output="$2"
  pitr_download_single_version_id="$(pitr_resolve_single_version "${pitr_download_single_target}")"
  pitr_download_version "${pitr_download_single_target}" "${pitr_download_single_version_id}" "${pitr_download_single_output}"
  printf '%s' "${pitr_download_single_version_id}"
}

pitr_upload_encrypted() {
  source_file="$1"
  target="$2"
  pitr_upload_stat="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-pitr-upload-stat.XXXXXX")"
  pitr_upload_source_dir="$(dirname "${source_file}")"
  [ -d "${pitr_upload_source_dir}" ] && [ -w "${pitr_upload_source_dir}" ] \
    || pitr_fail "PITR upload source directory must be writable for exact-version readback."
  pitr_upload_verify="$(mktemp "${pitr_upload_source_dir}/.lunchlineup-pitr-upload-verify.XXXXXX")"
  pitr_upload_exists=false
  if pitr_remote_stat_json "${target}" "${pitr_upload_stat}"; then
    pitr_upload_exists=true
  fi
  if [ "${pitr_upload_exists}" = false ]; then
    if pitr_mc --custom-header 'If-None-Match:*' cp \
      --checksum SHA256 \
      --disable-multipart \
      --retention-mode COMPLIANCE \
      --retention-duration "${PITR_OBJECT_LOCK_RETENTION_DAYS}d" \
      --enc-s3 "${target}" \
      "${source_file}" \
      "${target}" >/dev/null
    then
      :
    else
      pitr_upload_status=$?
      if ! pitr_remote_stat_json "${target}" "${pitr_upload_stat}"; then
        rm -f "${pitr_upload_stat}" "${pitr_upload_verify}"
        pitr_fail "Conditional PITR upload state is unknown and authenticated readback could not reconcile ${target}."
      fi
      echo "PITR conditional upload returned ${pitr_upload_status}; reconciling the immutable object through exact version readback." >&2
    fi
  fi
  pitr_upload_version="$(pitr_resolve_single_version "${target}")"
  pitr_download_version "${target}" "${pitr_upload_version}" "${pitr_upload_verify}"
  cmp -s "${source_file}" "${pitr_upload_verify}" \
    || { rm -f "${pitr_upload_stat}" "${pitr_upload_verify}"; pitr_fail "Remote PITR object conflicts with the immutable source bytes: ${target}."; }
  pitr_retention_info="$(pitr_mc retention info --version-id "${pitr_upload_version}" "${target}")" \
    || { rm -f "${pitr_upload_stat}" "${pitr_upload_verify}"; pitr_fail "Uploaded PITR version has no readable Object Lock retention."; }
  printf '%s\n' "${pitr_retention_info}" | grep -qi 'compliance' \
    || { rm -f "${pitr_upload_stat}" "${pitr_upload_verify}"; pitr_fail "Uploaded PITR version is not protected by COMPLIANCE Object Lock."; }
  rm -f "${pitr_upload_stat}" "${pitr_upload_verify}"
  printf '%s' "${pitr_upload_version}"
}
