#!/bin/bash
# scripts/provider-command-owner.sh
# Bounded process owner for provider CLIs used by the Node release, launch-proof and
# runtime-secret helpers (scripts/rehydrate-runtime-secret.mjs). Invoked only as
#   provider-command-owner.sh --provider-command --operation read|mutation ... -- <command> [args]
# It bounds runtime, escalates TERM to KILL, caps captured output and provider-written
# downloads, and gives mutations an explicit unknown-state exit. Extracted unchanged
# from the removed backup helper; it takes no backups.
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

  # The monitor subshell above is killed while it may be inside `sleep 0.05`
  # (or the initial `sleep 0.1`); that orphaned sleep is ours, not the provider's,
  # and exits on its own. Give such helpers a bounded moment to disappear, then
  # still fail closed on anything that outlives the grace window.
  survivor_checks=0
  until provider_container_job_survivors "$baseline_file"; do
    survivor_checks=$((survivor_checks + 1))
    if [ "$survivor_checks" -gt 40 ]; then
      echo "ERROR: Provider command left descendant processes; aborting the one-shot container ownership domain (pids=${provider_survivor_pids})." >&2
      exit 70
    fi
    sleep 0.05
  done

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

# This is the single process owner for provider CLIs used by the
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

  case "${PROVIDER_OWNERSHIP_MODE:-cgroup-v2}" in
    container-job)
      provider_command_container_job "$@"
      return $?
      ;;
    cgroup-v2) ;;
    *)
      rm -rf "$scratch"
      echo "ERROR: PROVIDER_OWNERSHIP_MODE must be cgroup-v2 or container-job." >&2
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

echo "ERROR: usage: provider-command-owner.sh --provider-command ... -- <command> [args]" >&2
exit 64
