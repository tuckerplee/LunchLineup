#!/bin/bash
# scripts/backup.sh
# Encrypted Postgres backup helper for production and disposable restore tests.
set -euo pipefail
IFS=$'\n\t'
umask 077

provider_cgroup_v2_create() {
  local cgroup_path cgroup_parent cgroup_domain
  awk '$5 == "/sys/fs/cgroup" && $0 ~ / - cgroup2 / { found=1 } END { exit !found }' /proc/self/mountinfo 2>/dev/null \
    || { echo "ERROR: Provider ownership requires cgroup v2 mounted at /sys/fs/cgroup." >&2; return 1; }
  cgroup_path="$(sed -n 's/^0:://p' /proc/self/cgroup)"
  case "${cgroup_path}" in /*) ;; *) echo "ERROR: Provider ownership could not resolve the current cgroup v2 path." >&2; return 1 ;; esac
  cgroup_parent="/sys/fs/cgroup${cgroup_path}"
  cgroup_domain="$(mktemp -d "${cgroup_parent%/}/lunchlineup-provider.XXXXXX" 2>/dev/null)" \
    || { echo "ERROR: Provider ownership requires a writable delegated cgroup v2 beneath ${cgroup_parent}." >&2; return 1; }
  if [ ! -w "${cgroup_domain}/cgroup.procs" ] \
    || [ ! -w "${cgroup_domain}/cgroup.kill" ] \
    || ! grep -q '^populated 0$' "${cgroup_domain}/cgroup.events" 2>/dev/null
  then
    rmdir -- "${cgroup_domain}" 2>/dev/null || true
    echo "ERROR: Provider ownership requires delegated cgroup.procs, cgroup.kill, and cgroup.events controls." >&2
    return 1
  fi
  printf '%s' "${cgroup_domain}"
}

provider_cgroup_v2_populated() {
  grep -q '^populated 1$' "$1/cgroup.events" 2>/dev/null
}

provider_cgroup_v2_empty() {
  grep -q '^populated 0$' "$1/cgroup.events" 2>/dev/null \
    && [ -z "$(cat "$1/cgroup.procs" 2>/dev/null)" ] \
    && grep -q '^populated 0$' "$1/cgroup.events" 2>/dev/null
}

provider_cgroup_v2_signal() {
  local cgroup_domain="$1"
  local signal_name="$2"
  local owned_pid
  while IFS= read -r owned_pid; do
    [ -z "${owned_pid}" ] || kill "-${signal_name}" "${owned_pid}" 2>/dev/null || true
  done <"${cgroup_domain}/cgroup.procs"
}

provider_cgroup_v2_terminate() {
  local cgroup_domain="$1"
  local kill_after_seconds="$2"
  local empty_checks=0
  provider_cgroup_v2_signal "${cgroup_domain}" TERM
  sleep "${kill_after_seconds}"
  if provider_cgroup_v2_populated "${cgroup_domain}"; then
    printf '1\n' >"${cgroup_domain}/cgroup.kill" \
      || { echo "ERROR: Could not KILL the complete provider cgroup v2 ownership domain." >&2; return 1; }
  fi
  while ! provider_cgroup_v2_empty "${cgroup_domain}"; do
    empty_checks=$((empty_checks + 1))
    [ "${empty_checks}" -le 100 ] \
      || { echo "ERROR: Provider cgroup v2 ownership domain did not become empty after KILL." >&2; return 1; }
    sleep 0.05
  done
}

provider_cgroup_v2_wait_stopped() {
  local child_pid="$1"
  local state=""
  local checks=0
  while [ "${checks}" -le 200 ]; do
    [ -r "/proc/${child_pid}/status" ] || return 1
    state="$(sed -n 's/^State:[[:space:]]*\([A-Za-z]\).*/\1/p' "/proc/${child_pid}/status")"
    [ "${state}" != T ] || return 0
    checks=$((checks + 1))
    sleep 0.01
  done
  return 1
}

provider_process_snapshot() {
  local process_dir
  for process_dir in /proc/[0-9]*; do
    [ -r "${process_dir}/status" ] || continue
    printf '%s\n' "${process_dir##*/}"
  done
}

provider_container_job_survivors() {
  local baseline_file="$1"
  local process_dir process_pid
  provider_survivor_pids=""
  for process_dir in /proc/[0-9]*; do
    [ -r "${process_dir}/status" ] || continue
    process_pid="${process_dir##*/}"
    if ! grep -Fxq "${process_pid}" "${baseline_file}"; then
      provider_survivor_pids="${provider_survivor_pids}${provider_survivor_pids:+ }${process_pid}"
    fi
  done
  [ -z "${provider_survivor_pids}" ]
}

provider_command_container_job() {
  local baseline_file="$scratch/process-baseline"
  local started_at now reason status stdout_bytes stderr_bytes download_bytes deadline

  provider_process_snapshot >"$baseline_file"
  "$@" >"$stdout_file" 2>"$stderr_file" &
  child_pid=$!
  started_at="$(date -u +%s)"
  deadline=$((started_at + timeout_seconds))
  (
    monitor_reason=""
    sleep 0.1
    while kill -0 "$child_pid" 2>/dev/null; do
      stdout_bytes="$(wc -c <"$stdout_file" | tr -d ' ')"
      stderr_bytes="$(wc -c <"$stderr_file" | tr -d ' ')"
      if [ $((stdout_bytes + stderr_bytes)) -gt "$max_output_bytes" ]; then
        monitor_reason="output-cap"
        break
      fi
      if [ -n "$download_path" ] && [ -e "$download_path" ]; then
        download_bytes="$(wc -c <"$download_path" 2>/dev/null | tr -d ' ' || printf '%s' 0)"
        if [ "$download_bytes" -gt "$max_download_bytes" ]; then
          monitor_reason="download-cap"
          break
        fi
      fi
      now="$(date -u +%s)"
      if [ "$now" -ge "$deadline" ]; then
        monitor_reason="timeout"
        break
      fi
      sleep 0.05
    done
    if [ -n "$monitor_reason" ]; then
      printf '%s\n' "$monitor_reason" >"$reason_file"
      kill -TERM "$child_pid" 2>/dev/null || true
      sleep "$kill_after_seconds"
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
  ) &
  monitor_pid=$!

  if wait "$child_pid"; then status=0; else status=$?; fi
  if [ -s "$reason_file" ]; then
    wait "$monitor_pid" >/dev/null 2>&1 || true
  else
    kill -TERM "$monitor_pid" >/dev/null 2>&1 || true
    wait "$monitor_pid" >/dev/null 2>&1 || true
  fi

  if ! provider_container_job_survivors "$baseline_file"; then
    echo "ERROR: Provider command left descendant processes; aborting the one-shot container ownership domain (pids=${provider_survivor_pids})." >&2
    exit 70
  fi

  reason=""
  [ ! -f "$reason_file" ] || reason="$(head -n 1 "$reason_file")"
  stdout_bytes="$(wc -c <"$stdout_file" | tr -d ' ')"
  stderr_bytes="$(wc -c <"$stderr_file" | tr -d ' ')"
  if [ -z "$reason" ] && [ $((stdout_bytes + stderr_bytes)) -gt "$max_output_bytes" ]; then reason="output-cap"; fi
  if [ -z "$reason" ] && [ -n "$download_path" ] && [ -e "$download_path" ]; then
    download_bytes="$(wc -c <"$download_path" 2>/dev/null | tr -d ' ' || printf '%s' 0)"
    [ "$download_bytes" -le "$max_download_bytes" ] || reason="download-cap"
  fi

  if [ -z "$reason" ] && [ "$status" -eq 0 ]; then
    cat "$stdout_file"
    cat "$stderr_file" >&2
    rm -rf "$scratch"
    return 0
  fi

  if [ "$stderr_bytes" -gt 0 ]; then head -c 4096 "$stderr_file" >&2 || true; fi
  rm -rf "$scratch"
  if [ "$operation" = mutation ] && [ "$status" -ne 127 ]; then
    echo "ERROR: Provider mutation state is unknown; authenticated readback reconciliation is required (reason=${reason:-exit-$status})." >&2
    return 70
  fi
  echo "ERROR: Provider read failed (reason=${reason:-exit-$status})." >&2
  if [ -z "$reason" ] && [ "$status" -gt 0 ] && [ "$status" -le 255 ]; then
    return "$status"
  fi
  return 69
}

# This is the single process owner for provider CLIs used by backup.sh and the
# Node release/launch/secret helpers. It bounds runtime, escalates TERM to KILL,
# caps captured output and provider-written downloads, and gives mutations an
# explicit unknown-state exit when completion cannot be proven.
provider_command_owner() {
  local operation=""
  local timeout_seconds=""
  local kill_after_seconds=""
  local max_output_bytes=""
  local download_path=""
  local max_download_bytes=""
  local scratch stdout_file stderr_file reason_file owner_error_file child_pid monitor_pid provider_cgroup
  local started_at now reason status stdout_bytes stderr_bytes download_bytes deadline

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --operation) operation="${2:-}"; shift 2 ;;
      --timeout-seconds) timeout_seconds="${2:-}"; shift 2 ;;
      --kill-after-seconds) kill_after_seconds="${2:-}"; shift 2 ;;
      --max-output-bytes) max_output_bytes="${2:-}"; shift 2 ;;
      --download-path) download_path="${2:-}"; shift 2 ;;
      --max-download-bytes) max_download_bytes="${2:-}"; shift 2 ;;
      --) shift; break ;;
      *) echo "ERROR: Unsupported provider-command option: $1" >&2; return 64 ;;
    esac
  done
  case "$operation" in read | mutation) ;; *) echo "ERROR: Provider operation must be read or mutation." >&2; return 64 ;; esac
  for value in "$timeout_seconds" "$kill_after_seconds" "$max_output_bytes"; do
    case "$value" in '' | *[!0-9]* | 0) echo "ERROR: Provider command bounds must be positive integers." >&2; return 64 ;; esac
  done
  [ "$timeout_seconds" -le 3600 ] && [ "$kill_after_seconds" -le 60 ] \
    || { echo "ERROR: Provider command timeout or kill-after exceeds its maximum." >&2; return 64; }
  [ "$max_output_bytes" -le 104857600 ] \
    || { echo "ERROR: Provider command output cap exceeds 104857600 bytes." >&2; return 64; }
  if [ -n "$download_path" ]; then
    case "$max_download_bytes" in '' | *[!0-9]* | 0) echo "ERROR: Provider download cap must be a positive integer." >&2; return 64 ;; esac
    [ "$max_download_bytes" -le 1073741824 ] \
      || { echo "ERROR: Provider download cap exceeds 1073741824 bytes." >&2; return 64; }
  elif [ -n "$max_download_bytes" ]; then
    echo "ERROR: --max-download-bytes requires --download-path." >&2
    return 64
  fi
  [ "$#" -gt 0 ] || { echo "ERROR: Provider command is required after --." >&2; return 64; }

  scratch="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-provider-command.XXXXXX")" \
    || { echo "ERROR: Could not create provider-command scratch directory." >&2; return 1; }
  stdout_file="$scratch/stdout"
  stderr_file="$scratch/stderr"
  reason_file="$scratch/reason"
  owner_error_file="$scratch/owner-error"
  : >"$stdout_file"
  : >"$stderr_file"

  case "${BACKUP_PROVIDER_OWNERSHIP_MODE:-cgroup-v2}" in
    container-job)
      provider_command_container_job "$@"
      return $?
      ;;
    cgroup-v2) ;;
    *)
      rm -rf "$scratch"
      echo "ERROR: BACKUP_PROVIDER_OWNERSHIP_MODE must be cgroup-v2 or container-job." >&2
      return 64
      ;;
  esac

  provider_cgroup="$(provider_cgroup_v2_create)" || {
    rm -rf "$scratch"
    echo "ERROR: Provider command was not started because no safe descendant ownership domain is available." >&2
    return 78
  }
  sh -c 'kill -STOP "$$"; exec "$@"' lunchlineup-provider-owner "$@" >"$stdout_file" 2>"$stderr_file" &
  child_pid=$!
  if ! provider_cgroup_v2_wait_stopped "${child_pid}" \
    || ! printf '%s\n' "${child_pid}" >"${provider_cgroup}/cgroup.procs" \
    || ! grep -Fxq "${child_pid}" "${provider_cgroup}/cgroup.procs"
  then
    kill -KILL "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true
    rmdir -- "${provider_cgroup}" 2>/dev/null || true
    rm -rf "$scratch"
    echo "ERROR: Provider command was not started because cgroup v2 ownership could not be established atomically." >&2
    return 78
  fi
  if ! kill -CONT "${child_pid}"; then
    kill -KILL "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true
    rmdir -- "${provider_cgroup}" 2>/dev/null || true
    rm -rf "$scratch"
    echo "ERROR: Provider command was not started because its cgroup v2 owner could not release the launch barrier." >&2
    return 78
  fi
  started_at="$(date -u +%s)"
  deadline=$((started_at + timeout_seconds))
  (
    monitor_reason=""
    # Give ordinary short provider calls a small fast-path window before the
    # monitor starts filesystem/accounting probes.
    sleep 0.1
    while provider_cgroup_v2_populated "${provider_cgroup}"; do
      stdout_bytes="$(wc -c <"$stdout_file" | tr -d ' ')"
      stderr_bytes="$(wc -c <"$stderr_file" | tr -d ' ')"
      if [ $((stdout_bytes + stderr_bytes)) -gt "$max_output_bytes" ]; then
        monitor_reason="output-cap"
        break
      fi
      if [ -n "$download_path" ] && [ -e "$download_path" ]; then
        download_bytes="$(wc -c <"$download_path" 2>/dev/null | tr -d ' ' || printf '%s' 0)"
        if [ "$download_bytes" -gt "$max_download_bytes" ]; then
          monitor_reason="download-cap"
          break
        fi
      fi
      now="$(date -u +%s)"
      if [ "$now" -ge "$deadline" ]; then
        monitor_reason="timeout"
        break
      fi
      sleep 0.05
    done
    if [ -n "$monitor_reason" ]; then
      printf '%s\n' "$monitor_reason" >"$reason_file"
      provider_cgroup_v2_terminate "${provider_cgroup}" "${kill_after_seconds}" \
        || printf '%s\n' termination-failed >"${owner_error_file}"
    fi
  ) &
  monitor_pid=$!

  if wait "$child_pid"; then status=0; else status=$?; fi
  if provider_cgroup_v2_populated "${provider_cgroup}"; then
    if [ -s "$reason_file" ]; then
      wait "$monitor_pid" >/dev/null 2>&1 || true
    else
      kill -TERM "$monitor_pid" >/dev/null 2>&1 || true
      wait "$monitor_pid" >/dev/null 2>&1 || true
      printf '%s\n' descendant-survivor >"$reason_file"
      provider_cgroup_v2_terminate "${provider_cgroup}" "${kill_after_seconds}" \
        || printf '%s\n' termination-failed >"${owner_error_file}"
    fi
  else
    kill -TERM "$monitor_pid" >/dev/null 2>&1 || true
    wait "$monitor_pid" >/dev/null 2>&1 || true
  fi
  if [ -s "${owner_error_file}" ] || ! provider_cgroup_v2_empty "${provider_cgroup}"; then
    echo "ERROR: Provider command ownership domain could not be proven empty; output cleanup is unsafe." >&2
    return 78
  fi
  rmdir -- "${provider_cgroup}" || {
    echo "ERROR: Provider command ownership domain could not be removed after empty proof." >&2
    return 78
  }
  reason=""
  [ ! -f "$reason_file" ] || reason="$(head -n 1 "$reason_file")"
  stdout_bytes="$(wc -c <"$stdout_file" | tr -d ' ')"
  stderr_bytes="$(wc -c <"$stderr_file" | tr -d ' ')"
  if [ -z "$reason" ] && [ $((stdout_bytes + stderr_bytes)) -gt "$max_output_bytes" ]; then reason="output-cap"; fi
  if [ -z "$reason" ] && [ -n "$download_path" ] && [ -e "$download_path" ]; then
    download_bytes="$(wc -c <"$download_path" 2>/dev/null | tr -d ' ' || printf '%s' 0)"
    [ "$download_bytes" -le "$max_download_bytes" ] || reason="download-cap"
  fi

  if [ -z "$reason" ] && [ "$status" -eq 0 ]; then
    cat "$stdout_file"
    cat "$stderr_file" >&2
    rm -rf "$scratch"
    return 0
  fi

  if [ "$stderr_bytes" -gt 0 ]; then head -c 4096 "$stderr_file" >&2 || true; fi
  rm -rf "$scratch"
  if [ "$operation" = mutation ] && [ "$status" -ne 127 ]; then
    echo "ERROR: Provider mutation state is unknown; authenticated readback reconciliation is required (reason=${reason:-exit-$status})." >&2
    return 70
  fi
  echo "ERROR: Provider read failed (reason=${reason:-exit-$status})." >&2
  if [ -z "$reason" ] && [ "$status" -gt 0 ] && [ "$status" -le 255 ]; then
    return "$status"
  fi
  return 69
}

if [ "${1:-}" = "--provider-command" ]; then
  shift
  provider_command_owner "$@"
  exit $?
fi

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is missing: $1"
}

is_unsigned_integer() {
  case "$1" in
    '' | *[!0-9]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

validate_backup_settings() {
  case "${BACKUP_DIR}" in
    '' | '/' | '.' | '..')
      fail "BACKUP_DIR must be a dedicated backup directory, not '${BACKUP_DIR}'."
      ;;
  esac

  [[ "${BACKUP_PREFIX}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "BACKUP_PREFIX must contain only letters, numbers, dots, underscores, or hyphens."
  case "${BACKUP_PREFIX}" in
    '.' | '..' | *'..'*) fail "BACKUP_PREFIX must be a simple filename prefix." ;;
  esac

  is_unsigned_integer "${BACKUP_RETENTION_DAYS}" || fail "BACKUP_RETENTION_DAYS must be a positive integer."
  [ "${BACKUP_RETENTION_DAYS}" -ge 1 ] || fail "BACKUP_RETENTION_DAYS must be at least 1."
  is_unsigned_integer "${BACKUP_OFFSITE_RETENTION_DAYS}" || fail "BACKUP_OFFSITE_RETENTION_DAYS must be a positive integer."
  [ "${BACKUP_OFFSITE_RETENTION_DAYS}" -ge 1 ] || fail "BACKUP_OFFSITE_RETENTION_DAYS must be at least 1."
  [ "${BACKUP_OFFSITE_RETENTION_DRY_RUN}" = "false" ] \
    || fail "BACKUP_OFFSITE_RETENTION_DRY_RUN is obsolete; immutable offsite expiry must be lifecycle-owned."
  is_unsigned_integer "${BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS}" \
    || fail "BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS must be a positive integer."
  [ "${BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS}" -ge "${BACKUP_OFFSITE_RETENTION_DAYS}" ] \
    && [ "${BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS}" -le 365 ] \
    || fail "BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS must cover immutable retention and be no more than 365."
  for provider_bound in \
    "${BACKUP_PROVIDER_TIMEOUT_SECONDS}" \
    "${BACKUP_PROVIDER_KILL_AFTER_SECONDS}" \
    "${BACKUP_PROVIDER_MAX_OUTPUT_BYTES}"
  do
    is_unsigned_integer "${provider_bound}" || fail "Backup provider command bounds must be positive integers."
  done
}

read_backup_key() {
  if [ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]; then
    [ -f "${BACKUP_ENCRYPTION_KEY_FILE}" ] || fail "BACKUP_ENCRYPTION_KEY_FILE does not exist."
    cat "${BACKUP_ENCRYPTION_KEY_FILE}"
    return
  fi

  [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || fail "Set BACKUP_ENCRYPTION_KEY_FILE or BACKUP_ENCRYPTION_KEY."
  printf '%s' "${BACKUP_ENCRYPTION_KEY}"
}

write_backup_metrics() {
  [ -n "${BACKUP_METRICS_FILE:-}" ] || return 0

  local metrics_dir
  local tmp_metrics_file
  metrics_dir="$(dirname "${BACKUP_METRICS_FILE}")"
  mkdir -p "${metrics_dir}"
  tmp_metrics_file="$(mktemp "${metrics_dir}/lunchlineup-backup.prom.tmp.XXXXXX")"

  cat >"${tmp_metrics_file}" <<METRICS
# HELP lunchlineup_backup_last_success_timestamp_seconds Unix timestamp of the last successful encrypted LunchLineup backup.
# TYPE lunchlineup_backup_last_success_timestamp_seconds gauge
lunchlineup_backup_last_success_timestamp_seconds ${BACKUP_COMPLETED_AT}
# HELP lunchlineup_backup_last_success_size_bytes Size in bytes of the last successful encrypted LunchLineup backup.
# TYPE lunchlineup_backup_last_success_size_bytes gauge
lunchlineup_backup_last_success_size_bytes ${BACKUP_SIZE_BYTES}
METRICS

  mv "${tmp_metrics_file}" "${BACKUP_METRICS_FILE}"
}

validate_offsite_repository() {
  local offsite_uri="$1"
  local target

  case "${offsite_uri}" in
    *[$'\t\r\n ']* | *'\'* | *'..'* | *'?'* | *'['* | *']'* | *'*'*)
      fail "BACKUP_OFFSITE_URI must be an exact repository without whitespace, traversal, or glob characters."
      ;;
    s3://*)
      target="${offsite_uri#s3://}"
      case "${target}" in /* | *'//'*) fail "BACKUP_OFFSITE_URI must use one non-root S3 prefix." ;; esac
      [ "${target}" != "${target#*/}" ] || fail "BACKUP_OFFSITE_URI must include a non-root S3 prefix."
      [ -n "${target%%/*}" ] && [ -n "${target#*/}" ] || fail "BACKUP_OFFSITE_URI must include an S3 bucket and non-root prefix."
      OFFSITE_KIND="s3"
      OFFSITE_REPOSITORY="s3://${target%/}"
      OFFSITE_S3_BUCKET="${target%%/*}"
      OFFSITE_S3_PREFIX="${target#*/}"
      OFFSITE_S3_PREFIX="${OFFSITE_S3_PREFIX%/}"
      ;;
    rclone:*)
      fail "Mutable rclone repositories cannot satisfy immutable production logical-backup proof; use versioned Object-Locked s3:// storage."
      ;;
    *)
      fail "Unsupported BACKUP_OFFSITE_URI. Immutable logical backups require s3://bucket/non-root-prefix."
      ;;
  esac
}

backup_provider_read() {
  provider_command_owner \
    --operation read \
    --timeout-seconds "${BACKUP_PROVIDER_TIMEOUT_SECONDS}" \
    --kill-after-seconds "${BACKUP_PROVIDER_KILL_AFTER_SECONDS}" \
    --max-output-bytes "${BACKUP_PROVIDER_MAX_OUTPUT_BYTES}" \
    -- "$@"
}

backup_provider_mutation() {
  provider_command_owner \
    --operation mutation \
    --timeout-seconds "${BACKUP_PROVIDER_TIMEOUT_SECONDS}" \
    --kill-after-seconds "${BACKUP_PROVIDER_KILL_AFTER_SECONDS}" \
    --max-output-bytes "${BACKUP_PROVIDER_MAX_OUTPUT_BYTES}" \
    -- "$@"
}

verify_backup_s3_protection() {
  local versioning_file object_lock_file lifecycle_file policy_file identity_file
  BACKUP_PROVIDER_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-backup-provider.XXXXXX")"
  versioning_file="${BACKUP_PROVIDER_SCRATCH}/versioning.json"
  object_lock_file="${BACKUP_PROVIDER_SCRATCH}/object-lock.json"
  lifecycle_file="${BACKUP_PROVIDER_SCRATCH}/lifecycle.json"
  policy_file="${BACKUP_PROVIDER_SCRATCH}/policy.json"
  identity_file="${BACKUP_PROVIDER_SCRATCH}/identity.json"

  backup_provider_read aws s3api get-bucket-versioning --bucket "${OFFSITE_S3_BUCKET}" --output json >"${versioning_file}"
  backup_provider_read aws s3api get-object-lock-configuration --bucket "${OFFSITE_S3_BUCKET}" --output json >"${object_lock_file}"
  backup_provider_read aws s3api get-bucket-lifecycle-configuration --bucket "${OFFSITE_S3_BUCKET}" --output json >"${lifecycle_file}"
  backup_provider_read aws s3api get-bucket-policy --bucket "${OFFSITE_S3_BUCKET}" --output json >"${policy_file}"
  backup_provider_read aws sts get-caller-identity --output json >"${identity_file}"

  BACKUP_OFFSITE_PRINCIPAL="$(python3 - \
    "${versioning_file}" \
    "${object_lock_file}" \
    "${lifecycle_file}" \
    "${policy_file}" \
    "${identity_file}" \
    "${OFFSITE_S3_BUCKET}" \
    "${OFFSITE_S3_PREFIX}" \
    "${BACKUP_OFFSITE_RETENTION_DAYS}" \
    "${BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS}" <<'PY'
import json
import sys

versioning_path, lock_path, lifecycle_path, policy_path, identity_path, bucket, prefix, minimum_text, maximum_text = sys.argv[1:]
minimum = int(minimum_text)
maximum = int(maximum_text)
load = lambda path: json.load(open(path, encoding='utf-8'))
versioning = load(versioning_path)
lock = load(lock_path)
lifecycle = load(lifecycle_path)
policy_envelope = load(policy_path)
identity = load(identity_path)
if versioning.get('Status') != 'Enabled':
    raise SystemExit('Backup bucket versioning must be Enabled.')
configuration = lock.get('ObjectLockConfiguration') or {}
retention = ((configuration.get('Rule') or {}).get('DefaultRetention') or {})
if configuration.get('ObjectLockEnabled') != 'Enabled' or retention.get('Mode') != 'COMPLIANCE':
    raise SystemExit('Backup bucket default Object Lock must be Enabled in COMPLIANCE mode.')
retention_days = retention.get('Days') or (retention.get('Years') or 0) * 365
if not isinstance(retention_days, int) or retention_days < minimum or retention_days > maximum:
    raise SystemExit('Backup bucket Object Lock retention is outside the approved lifecycle bounds.')

current = False
noncurrent = False
for rule in lifecycle.get('Rules') or []:
    if rule.get('Status') != 'Enabled':
        continue
    if 'Prefix' in rule and 'Filter' not in rule:
        rule_prefix = rule.get('Prefix')
    else:
        filter_value = rule.get('Filter', {})
        rule_prefix = filter_value.get('Prefix') if isinstance(filter_value, dict) and set(filter_value) <= {'Prefix'} else None
    if not isinstance(rule_prefix, str):
        continue
    rule_prefix = rule_prefix.strip('/')
    if rule_prefix and prefix != rule_prefix and not prefix.startswith(rule_prefix + '/'):
        continue
    expiration = rule.get('Expiration') or {}
    if 'Date' in expiration:
        raise SystemExit('Backup lifecycle must not use an absolute expiry date.')
    days = expiration.get('Days')
    if isinstance(days, int) and minimum <= days <= maximum:
        current = True
    noncurrent_days = (rule.get('NoncurrentVersionExpiration') or {}).get('NoncurrentDays')
    if isinstance(noncurrent_days, int) and minimum <= noncurrent_days <= maximum:
        noncurrent = True
if not current or not noncurrent:
    raise SystemExit('Backup lifecycle must bound current and noncurrent expiry for the exact backup prefix.')

try:
    policy = json.loads(policy_envelope['Policy'])
except (KeyError, TypeError, json.JSONDecodeError):
    raise SystemExit('Backup bucket deletion-deny policy is missing or invalid.')
statements = policy.get('Statement') or []
if not isinstance(statements, list):
    statements = [statements]
denied = set()
allowed_resources = {
    f'arn:aws:s3:::{bucket}/*',
    f'arn:aws:s3:::{bucket}/{prefix}/*',
}
for statement in statements:
    if not isinstance(statement, dict) or statement.get('Effect') != 'Deny' or 'Condition' in statement or 'NotPrincipal' in statement:
        continue
    principal = statement.get('Principal')
    all_principals = principal == '*' or (isinstance(principal, dict) and principal.get('AWS') == '*') or (
        isinstance(principal, dict) and isinstance(principal.get('AWS'), list) and '*' in principal['AWS']
    )
    resources = statement.get('Resource') or []
    if not isinstance(resources, list):
        resources = [resources]
    if not all_principals or not any(resource in allowed_resources for resource in resources):
        continue
    actions = statement.get('Action') or []
    if not isinstance(actions, list):
        actions = [actions]
    for action in (str(value).lower() for value in actions):
        if action in {'s3:*', 's3:delete*', 's3:deleteobject*'}:
            denied.update({'s3:deleteobject', 's3:deleteobjectversion'})
        elif action in {'s3:deleteobject', 's3:deleteobjectversion'}:
            denied.add(action)
if denied != {'s3:deleteobject', 's3:deleteobjectversion'}:
    raise SystemExit('Backup bucket policy must unconditionally deny object and version deletion for all identities on the exact prefix.')
principal = identity.get('Arn')
if not isinstance(principal, str) or len(principal) < 8 or any(character.isspace() for character in principal):
    raise SystemExit('Backup provider identity readback is missing an authenticated principal ARN.')
print(principal, end='')
PY
  )" || fail "Immutable logical-backup provider protection preflight failed."
}

put_immutable_backup_object() {
  local source_file="$1"
  local object_name object_key checksum_hex checksum_base64 retain_until put_json version_id head_file expected_bytes
  object_name="$(basename "${source_file}")"
  object_key="${OFFSITE_S3_PREFIX}/${object_name}"
  checksum_hex="$(sha256sum "${source_file}" | awk '{print tolower($1)}')"
  checksum_base64="$(python3 - "${checksum_hex}" <<'PY'
import base64
import sys
print(base64.b64encode(bytes.fromhex(sys.argv[1])).decode(), end='')
PY
  )"
  retain_until="$(date -u -d "+${BACKUP_OFFSITE_RETENTION_DAYS} days" +%Y-%m-%dT%H:%M:%SZ)" \
    || fail "Unable to calculate immutable backup retention timestamp."
  put_json=""
  if put_json="$(backup_provider_mutation aws s3api put-object \
    --bucket "${OFFSITE_S3_BUCKET}" \
    --key "${object_key}" \
    --body "${source_file}" \
    --if-none-match '*' \
    --checksum-algorithm SHA256 \
    --checksum-sha256 "${checksum_base64}" \
    --object-lock-mode COMPLIANCE \
    --object-lock-retain-until-date "${retain_until}" \
    --output json)"; then
    version_id="$(printf '%s' "${put_json}" | python3 -c 'import json,sys; value=json.load(sys.stdin).get("VersionId"); print(value if isinstance(value,str) else "", end="")')"
  else
    version_id=""
  fi

  head_file="${BACKUP_PROVIDER_SCRATCH}/head-$(printf '%s' "${object_name}" | tr -c 'A-Za-z0-9._-' '_').json"
  if [ -n "${version_id}" ] && [ "${version_id}" != null ]; then
    backup_provider_read aws s3api head-object \
      --bucket "${OFFSITE_S3_BUCKET}" --key "${object_key}" --version-id "${version_id}" \
      --checksum-mode ENABLED --output json >"${head_file}"
  else
    backup_provider_read aws s3api head-object \
      --bucket "${OFFSITE_S3_BUCKET}" --key "${object_key}" \
      --checksum-mode ENABLED --output json >"${head_file}"
    version_id="$(python3 -c 'import json,sys; value=json.load(open(sys.argv[1])).get("VersionId"); print(value if isinstance(value,str) else "", end="")' "${head_file}")"
  fi
  case "${version_id}" in '' | null | latest) fail "Immutable backup provider readback did not return an exact version ID." ;; esac
  expected_bytes="$(wc -c <"${source_file}" | tr -d ' ')"
  if ! python3 - "${head_file}" "${version_id}" "${expected_bytes}" "${checksum_base64}" \
    "${BACKUP_OFFSITE_RETENTION_DAYS}" "${BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS}" <<'PY'
import datetime
import json
import sys

path, version_id, expected_bytes, checksum, minimum_days, maximum_days = sys.argv[1:]
metadata = json.load(open(path, encoding='utf-8'))
if metadata.get('VersionId') != version_id or version_id in {'', 'null', 'latest'}:
    raise SystemExit(1)
if metadata.get('ContentLength') != int(expected_bytes) or metadata.get('ChecksumSHA256') != checksum:
    raise SystemExit(1)
if metadata.get('DeleteMarker') is True or metadata.get('ObjectLockMode') != 'COMPLIANCE':
    raise SystemExit(1)
parse = lambda value: datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
last_modified = parse(metadata.get('LastModified'))
retain_until = parse(metadata.get('ObjectLockRetainUntilDate'))
days = (retain_until - last_modified).total_seconds() / 86400
if days < int(minimum_days) - 0.01 or days > int(maximum_days) + 0.01:
    raise SystemExit(1)
PY
  then
    fail "Immutable backup provider readback does not match the uploaded object."
  fi
  printf '%s' "${version_id}"
}

sync_offsite() {
  local offsite_uri="${BACKUP_OFFSITE_URI:-}"

  if [ -z "${offsite_uri}" ] && [ "${BACKUP_OFFSITE_ENABLED:-false}" = "true" ]; then
    [ -n "${BACKUP_S3_BUCKET:-}" ] || fail "BACKUP_S3_BUCKET or BACKUP_OFFSITE_URI is required when BACKUP_OFFSITE_ENABLED=true."
    offsite_uri="s3://${BACKUP_S3_BUCKET}/db-backups/"
  fi

  [ -n "${offsite_uri}" ] || return 0
  validate_offsite_repository "${offsite_uri}"
  BACKUP_OFFSITE_PROOF_URI="${OFFSITE_REPOSITORY}/"
  require_command aws
  require_command python3
  [ -r "${AWS_SHARED_CREDENTIALS_FILE:-}" ] || fail "AWS_SHARED_CREDENTIALS_FILE must name a readable dedicated credentials file for s3 backups."
  verify_backup_s3_protection
  BACKUP_OFFSITE_OBJECT_VERSION="$(put_immutable_backup_object "${BACKUP_FILE}")"
  BACKUP_OFFSITE_CHECKSUM_VERSION="$(put_immutable_backup_object "${BACKUP_FILE}.sha256")"
  BACKUP_OFFSITE_OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'offsite_retention_ok mode=lifecycle_owned repository=%s immutable_days=%s lifecycle_max_days=%s delete=denied\n' \
    "${BACKUP_OFFSITE_PROOF_URI}" "${BACKUP_OFFSITE_RETENTION_DAYS}" "${BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS}"
  printf 'offsite_immutable_ok object_version=%s checksum_version=%s principal=%s observed_at=%s\n' \
    "${BACKUP_OFFSITE_OBJECT_VERSION}" \
    "${BACKUP_OFFSITE_CHECKSUM_VERSION}" \
    "${BACKUP_OFFSITE_PRINCIPAL}" \
    "${BACKUP_OFFSITE_OBSERVED_AT}"
}

write_backup_proof() {
  printf 'backup_ok backup_file=%s checksum_file=%s backup_sha256=%s size_bytes=%s offsite_uri=%s offsite_version=%s checksum_version=%s provider_principal=%s provider_observed_at=%s expiry_owner=lifecycle completed_at=%s\n' \
    "${BACKUP_FILE}" \
    "${BACKUP_FILE}.sha256" \
    "${BACKUP_SHA256}" \
    "${BACKUP_SIZE_BYTES}" \
    "${BACKUP_OFFSITE_PROOF_URI:-none}" \
    "${BACKUP_OFFSITE_OBJECT_VERSION:-none}" \
    "${BACKUP_OFFSITE_CHECKSUM_VERSION:-none}" \
    "${BACKUP_OFFSITE_PRINCIPAL:-none}" \
    "${BACKUP_OFFSITE_OBSERVED_AT:-none}" \
    "${BACKUP_COMPLETED_AT}"
}

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-lunchlineup}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"
BACKUP_OFFSITE_RETENTION_DAYS="${BACKUP_OFFSITE_RETENTION_DAYS:-35}"
BACKUP_OFFSITE_RETENTION_DRY_RUN="${BACKUP_OFFSITE_RETENTION_DRY_RUN:-false}"
BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS="${BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS:-90}"
BACKUP_PROVIDER_TIMEOUT_SECONDS="${BACKUP_PROVIDER_TIMEOUT_SECONDS:-120}"
BACKUP_PROVIDER_KILL_AFTER_SECONDS="${BACKUP_PROVIDER_KILL_AFTER_SECONDS:-5}"
BACKUP_PROVIDER_MAX_OUTPUT_BYTES="${BACKUP_PROVIDER_MAX_OUTPUT_BYTES:-4194304}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-lunchlineup}"
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
BACKUP_OFFSITE_PROOF_URI=""
BACKUP_PROVIDER_SCRATCH=""

validate_backup_settings
if [ -n "${BACKUP_OFFSITE_URI:-}" ]; then
  validate_offsite_repository "${BACKUP_OFFSITE_URI}"
elif [ "${BACKUP_OFFSITE_ENABLED:-false}" = "true" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  validate_offsite_repository "s3://${BACKUP_S3_BUCKET}/db-backups/"
fi
require_command pg_dump
require_command zstd
require_command gpg
require_command sha256sum
require_command mktemp

mkdir -p "${BACKUP_DIR}"
BACKUP_FILE="${BACKUP_DIR}/${BACKUP_PREFIX}-${TIMESTAMP}.sql.zst.gpg"
TMP_BACKUP_FILE="$(mktemp "${BACKUP_DIR}/${BACKUP_PREFIX}-${TIMESTAMP}.sql.zst.gpg.tmp.XXXXXX")"
BACKUP_KEY="$(read_backup_key)"

cleanup() {
  rm -f "${TMP_BACKUP_FILE}"
  [ -z "${BACKUP_PROVIDER_SCRATCH}" ] || rm -rf "${BACKUP_PROVIDER_SCRATCH}"
}
trap cleanup EXIT

echo "Starting encrypted backup to ${BACKUP_FILE}..."

pg_dump \
  -U "${POSTGRES_USER}" \
  -h "${POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  "${POSTGRES_DB}" \
  | zstd -T0 -c \
  | gpg \
      --symmetric \
      --batch \
      --yes \
      --pinentry-mode loopback \
      --cipher-algo AES256 \
      --passphrase-fd 3 \
      -o "${TMP_BACKUP_FILE}" \
      3<<<"${BACKUP_KEY}"

[ -s "${TMP_BACKUP_FILE}" ] || fail "Backup output is empty."
mv "${TMP_BACKUP_FILE}" "${BACKUP_FILE}"
BACKUP_SHA256_LINE="$(sha256sum "${BACKUP_FILE}")"
BACKUP_SHA256="${BACKUP_SHA256_LINE%% *}"
printf '%s  %s\n' "${BACKUP_SHA256}" "$(basename "${BACKUP_FILE}")" >"${BACKUP_FILE}.sha256"

sync_offsite

BACKUP_COMPLETED_AT="$(date -u +%s)"
BACKUP_SIZE_BYTES="$(wc -c <"${BACKUP_FILE}" | tr -d ' ')"
write_backup_metrics

find "${BACKUP_DIR}" -type f \( -name "${BACKUP_PREFIX}-*.sql.zst.gpg" -o -name "${BACKUP_PREFIX}-*.sql.zst.gpg.sha256" \) -mtime +"${BACKUP_RETENTION_DAYS}" -delete

echo "Backup process finished successfully: ${BACKUP_FILE}"
write_backup_proof
