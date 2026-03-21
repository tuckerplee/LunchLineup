#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
LOCK_FILE="${LOCK_FILE:-/tmp/lunchlineup-deploy.lock}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/api/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
SECRETS_DIR="${SECRETS_DIR:-/opt/lunchlineup-secrets}"
SECRET_ENV_PATH="${SECRET_ENV_PATH:-$SECRETS_DIR/runtime.env}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another deploy is already running (lock: $LOCK_FILE)" >&2
  exit 1
fi

cd "$APP_DIR"

# Keep runtime secrets outside the rsynced tree and force .env to point there.
mkdir -p "$SECRETS_DIR"
if [[ ! -f "$SECRET_ENV_PATH" ]]; then
  if [[ -f .env && ! -L .env ]]; then
    cp .env "$SECRET_ENV_PATH"
    chmod 600 "$SECRET_ENV_PATH"
    echo "Bootstrapped $SECRET_ENV_PATH from existing $APP_DIR/.env"
  else
    echo "Missing secret env file: $SECRET_ENV_PATH" >&2
    exit 1
  fi
fi
ln -sfn "$SECRET_ENV_PATH" .env

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
docker compose --env-file "$SECRET_ENV_PATH" up -d --build "${services[@]}"

# Apply plan-definition schema migration after containers are up.
# This migration is idempotent and prevents admin /plans 500s on fresh databases.
PLAN_MIGRATION_PATH="/app/packages/db/prisma/migrations/20260321_plan_definitions.sql"
if docker exec lunchlineup-api sh -lc "[ -f \"$PLAN_MIGRATION_PATH\" ]"; then
  echo "Applying plan migration: 20260321_plan_definitions.sql"
  docker exec lunchlineup-api sh -lc \
    "npx prisma db execute --schema=/app/packages/db/prisma/schema.prisma --file=$PLAN_MIGRATION_PATH"
fi

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
