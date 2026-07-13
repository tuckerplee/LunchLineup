#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
COMPOSE_SERVICE_ENV_FILE="${COMPOSE_SERVICE_ENV_FILE:?COMPOSE_SERVICE_ENV_FILE is required}"
IMAGE_PREFIX="${IMAGE_PREFIX:?IMAGE_PREFIX is required}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
METRICS_DIR="${NODE_EXPORTER_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
MAX_METRIC_AGE_SECONDS="${BACKUP_PROOF_MAX_AGE_SECONDS:-300}"

fail() { echo "$1" >&2; exit 1; }
[[ "$MAX_METRIC_AGE_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_PROOF_MAX_AGE_SECONDS must be positive."
[[ "$(id -u)" == "0" ]] || fail "Backup scheduler installation requires root."
export IMAGE_PREFIX IMAGE_TAG

services=(lunchlineup-backup.service lunchlineup-pitr-base-backup.service)
timers=(lunchlineup-backup.timer lunchlineup-pitr-base-backup.timer)
verification_complete=false
backup_log=""
pitr_log=""
timer_state_file="$(mktemp)"

restore_timer_state() {
  local timer
  local was_enabled
  local was_active

  while IFS='|' read -r timer was_enabled was_active; do
    [[ -n "$timer" ]] || continue
    if [[ "$was_enabled" == "true" ]]; then
      systemctl enable "$timer" >/dev/null 2>&1 || true
    else
      systemctl disable "$timer" >/dev/null 2>&1 || true
    fi
    if [[ "$was_active" == "true" ]]; then
      systemctl start "$timer" >/dev/null 2>&1 || true
    else
      systemctl stop "$timer" >/dev/null 2>&1 || true
    fi
  done < "$timer_state_file"
}

cleanup_verification() {
  local exit_code=$?
  rm -f "${backup_log:-}" "${pitr_log:-}"
  if [[ "$verification_complete" != "true" ]]; then
    restore_timer_state
  fi
  rm -f "$timer_state_file"
  return "$exit_code"
}

for timer in "${timers[@]}"; do
  was_enabled=false
  was_active=false
  systemctl is-enabled --quiet "$timer" >/dev/null 2>&1 && was_enabled=true
  systemctl is-active --quiet "$timer" >/dev/null 2>&1 && was_active=true
  printf '%s|%s|%s\n' "$timer" "$was_enabled" "$was_active" >> "$timer_state_file"
done
trap cleanup_verification EXIT
systemctl disable --now "${timers[@]}" >/dev/null 2>&1 || true
required_environment_files=(
  /etc/lunchlineup/backup.env
  /var/lib/lunchlineup/backup-release.env
  /etc/lunchlineup/pitr-base-backup.env
)

for environment_file in "${required_environment_files[@]}"; do
  [[ -f "$environment_file" && -r "$environment_file" ]] \
    || fail "Required systemd EnvironmentFile is missing or unreadable: $environment_file"
done

for service in "${services[@]}"; do
  unit="$APP_DIR/infrastructure/systemd/$service"
  [[ -f "$unit" ]] || fail "Required backup service unit is missing: $unit"
done
for timer in "${timers[@]}"; do
  unit="$APP_DIR/infrastructure/systemd/$timer"
  [[ -f "$unit" ]] || fail "Required backup timer unit is missing: $unit"
done

APP_DIR="$APP_DIR" \
  COMPOSE_SERVICE_ENV_FILE="$COMPOSE_SERVICE_ENV_FILE" \
  IMAGE_PREFIX="$IMAGE_PREFIX" \
  IMAGE_TAG="$IMAGE_TAG" \
  bash "$APP_DIR/scripts/pitr-verify-storage.sh"

unit_paths=()
for unit in "${services[@]}" "${timers[@]}"; do
  unit_path="/etc/systemd/system/$unit"
  install -m 0644 "$APP_DIR/infrastructure/systemd/$unit" "$unit_path"
  unit_paths+=("$unit_path")
done
systemd-analyze verify "${unit_paths[@]}"
systemctl daemon-reload


backup_log="$(mktemp)"
pitr_log="$(mktemp)"


run_backup_service() {
  service="$1"
  log_file="$2"
  started_at="$(date --iso-8601=seconds)"
  systemctl reset-failed "$service" >/dev/null 2>&1 || true
  if ! systemctl start "$service"; then
    journalctl --unit "$service" --since "$started_at" --no-pager --output=cat >"$log_file" || true
    cat "$log_file" >&2
    fail "$service failed."
  fi
  journalctl --unit "$service" --since "$started_at" --no-pager --output=cat >"$log_file"
  [[ "$(systemctl show "$service" --property=Result --value)" == "success" ]] \
    || fail "$service did not report Result=success."
  [[ "$(systemctl show "$service" --property=ExecMainStatus --value)" == "0" ]] \
    || fail "$service did not exit successfully."
}

run_backup_service lunchlineup-backup.service "$backup_log"
grep -q '^offsite_retention_ok ' "$backup_log" || fail "Backup one-shot did not prove offsite retention."
grep -q '^backup_ok ' "$backup_log" || fail "Backup one-shot did not complete."

run_backup_service lunchlineup-pitr-base-backup.service "$pitr_log"
grep -q '^pitr_base_backup_ok ' "$pitr_log" || fail "PITR one-shot did not complete."

python3 - "$METRICS_DIR/lunchlineup_backup.prom" "$METRICS_DIR/lunchlineup_pitr.prom" "$MAX_METRIC_AGE_SECONDS" <<'PY'
import re
import sys
import time

checks = [
    (sys.argv[1], 'lunchlineup_backup_last_success_timestamp_seconds'),
    (sys.argv[2], 'lunchlineup_pitr_base_backup_last_success_timestamp_seconds'),
]
now = int(time.time())
max_age = int(sys.argv[3])
for path, metric in checks:
    try:
        content = open(path, encoding='utf-8').read()
    except OSError as error:
        raise SystemExit(f'missing backup metrics proof: {path}: {error}')
    match = re.search(rf'^{re.escape(metric)}\s+(\d+)$', content, re.MULTILINE)
    if not match or now - int(match.group(1)) > max_age or int(match.group(1)) > now + 60:
        raise SystemExit(f'backup metrics proof is missing or stale: {metric}')
PY

systemctl enable --now "${timers[@]}" >/dev/null
for timer in "${timers[@]}"; do
  systemctl is-enabled --quiet "$timer" || fail "$timer is not enabled."
  systemctl is-active --quiet "$timer" || fail "$timer is not active."
done

printf 'backup_readiness_ok release_sha=%s timers=enabled-active one_shot=backup-pitr offsite=verified metrics=fresh\n' "$IMAGE_TAG"
verification_complete=true
