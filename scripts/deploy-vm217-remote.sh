#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
LOCK_FILE="${LOCK_FILE:-/tmp/lunchlineup-deploy.lock}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/api/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another deploy is already running (lock: $LOCK_FILE)" >&2
  exit 1
fi

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "Missing $APP_DIR/.env" >&2
  exit 1
fi

# Worktree syncs can copy a .git file pointer from a local machine. Keep server deploys git-agnostic.
if [[ -f .git && ! -d .git ]]; then
  mv .git ".git.worktree-link.broken.$(date +%Y%m%d%H%M%S)"
fi

services=(
  proxy web api engine worker
  pgbouncer postgres redis rabbitmq
  prometheus loki tempo grafana autoheal
)

echo "Deploying services: ${services[*]}"
docker compose up -d --build "${services[@]}"

start_time=$(date +%s)
while true; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
  if [[ "$code" == "200" ]]; then
    echo "Health check passed: $HEALTH_URL"
    break
  fi

  now=$(date +%s)
  if (( now - start_time > HEALTH_TIMEOUT_SECONDS )); then
    echo "Health check timed out after ${HEALTH_TIMEOUT_SECONDS}s (last code: $code)" >&2
    docker compose ps
    exit 1
  fi

  sleep 5
done

docker compose ps
