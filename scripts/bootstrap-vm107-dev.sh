#!/usr/bin/env bash
# scripts/bootstrap-vm107-dev.sh
# Bootstrap a fresh VM107-style LunchLineup dev host from GitHub, then optionally
# restore an existing Postgres dump. This script is for disposable private dev
# servers only; do not run it against production VM106.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
REPO_URL="${REPO_URL:-https://github.com/tuckerplee/LunchLineup.git}"
BRANCH="${BRANCH:-migration-testing-baseline}"
SECRETS_DIR="${SECRETS_DIR:-/opt/lunchlineup-secrets}"
SECRET_ENV_PATH="${SECRET_ENV_PATH:-$SECRETS_DIR/runtime.env}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/health}"
HOST_HEADER="${HOST_HEADER:-dev.lunchlineup.com}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
BACKUP_FILE="${BACKUP_FILE:-}"

services=(
  proxy web api engine worker
  pgbouncer postgres redis rabbitmq
  prometheus loki tempo grafana autoheal
)

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run as root or through sudo on the disposable dev VM." >&2
    exit 1
  fi
}

install_host_dependencies() {
  apt-get update
  apt-get install -y ca-certificates curl git gnupg openssl zstd

  if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    . /etc/os-release
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  systemctl enable --now docker
  systemctl disable --now apache2 nginx 2>/dev/null || true
  mkdir -p "$(dirname "$APP_DIR")" "$SECRETS_DIR"
}

sync_repository() {
  if [[ ! -d "$APP_DIR/.git" ]]; then
    rm -rf "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
  fi

  cd "$APP_DIR"
  git fetch origin
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git checkout "$BRANCH"
  else
    git checkout -b "$BRANCH" "origin/$BRANCH"
  fi
  git pull --ff-only origin "$BRANCH"
}

upsert_env() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "$SECRET_ENV_PATH"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$SECRET_ENV_PATH"
  else
    printf "%s=%s\n" "$key" "$value" >> "$SECRET_ENV_PATH"
  fi
}

prepare_runtime_env() {
  cd "$APP_DIR"

  if [[ ! -f "$SECRET_ENV_PATH" ]]; then
    cp .env.example "$SECRET_ENV_PATH"
    chmod 600 "$SECRET_ENV_PATH"
    upsert_env JWT_SECRET "$(openssl rand -hex 64)"
    upsert_env JWT_REFRESH_SECRET "$(openssl rand -hex 64)"
    upsert_env SESSION_SECRET "$(openssl rand -hex 64)"
    upsert_env CSRF_SECRET "$(openssl rand -hex 32)"
  fi

  chmod 600 "$SECRET_ENV_PATH"
  upsert_env NODE_ENV production
  upsert_env DOMAIN "$HOST_HEADER"
  upsert_env DATABASE_URL "postgresql://root:password@postgres:5432/lunchlineup"
  upsert_env POSTGRES_USER root
  upsert_env POSTGRES_PASSWORD password
  upsert_env POSTGRES_DB lunchlineup
  upsert_env REDIS_URL "redis://redis:6379"
  upsert_env RABBITMQ_URL "amqp://guest:guest@rabbitmq:5672"
  upsert_env NEXT_PUBLIC_API_URL "/api/v1"
  upsert_env INTERNAL_API_URL "http://api:3000/v1"
  upsert_env NEXT_PUBLIC_OIDC_ENABLED false
  upsert_env OIDC_ENABLED false
  upsert_env COOKIE_SECURE false
  upsert_env ALLOWED_HOSTS "10.231.10.108,10.231.10.108:80,dev.lunchlineup.com,lunchlineup-dev.proxmox1.lan,lunchlineup-dev-vm.proxmox1.lan"
  upsert_env ALLOWED_ORIGINS "http://10.231.10.108,http://dev.lunchlineup.com,http://lunchlineup-dev.proxmox1.lan,http://lunchlineup-dev-vm.proxmox1.lan"
  upsert_env RESEND_API_KEY "${RESEND_API_KEY:-placeholder_resend_key}"
  upsert_env EMAIL_FROM "${EMAIL_FROM:-LunchLineup Dev <no-reply@dev.lunchlineup.com>}"

  ln -sfn "$SECRET_ENV_PATH" .env
}

start_stack() {
  cd "$APP_DIR"
  docker compose --env-file "$SECRET_ENV_PATH" up -d --build "${services[@]}"
  docker exec lunchlineup-api npx prisma db push --schema /app/packages/db/prisma/schema.prisma
}

restore_backup_if_requested() {
  if [[ -z "$BACKUP_FILE" ]]; then
    return
  fi
  if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "BACKUP_FILE does not exist: $BACKUP_FILE" >&2
    exit 1
  fi

  echo "Restoring Postgres data from $BACKUP_FILE"
  case "$BACKUP_FILE" in
    *.sql)
      docker exec -i lunchlineup-postgres psql -U root -d lunchlineup < "$BACKUP_FILE"
      ;;
    *.sql.zst)
      zstd -d -c "$BACKUP_FILE" | docker exec -i lunchlineup-postgres psql -U root -d lunchlineup
      ;;
    *.sql.zst.gpg)
      if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
        echo "BACKUP_ENCRYPTION_KEY is required for encrypted backups." >&2
        exit 1
      fi
      gpg --decrypt --batch --passphrase "$BACKUP_ENCRYPTION_KEY" "$BACKUP_FILE" \
        | zstd -d -c \
        | docker exec -i lunchlineup-postgres psql -U root -d lunchlineup
      ;;
    *)
      echo "Unsupported BACKUP_FILE format. Use .sql, .sql.zst, or .sql.zst.gpg." >&2
      exit 1
      ;;
  esac
}

write_deploy_proof() {
  cd "$APP_DIR"
  git rev-parse HEAD > DEPLOYED_GIT_SHA
}

wait_for_health() {
  local start_time
  start_time="$(date +%s)"

  while true; do
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)"
    local host_code
    host_code="$(curl -s -o /dev/null -w "%{http_code}" -H "Host: ${HOST_HEADER}" "http://127.0.0.1/health" || true)"
    if [[ "$code" == "200" && "$host_code" == "200" ]]; then
      break
    fi

    if (( "$(date +%s)" - start_time > HEALTH_TIMEOUT_SECONDS )); then
      echo "Health check timed out. direct=$code host_header=$host_code" >&2
      docker compose ps
      exit 1
    fi
    sleep 5
  done
}

main() {
  require_root
  install_host_dependencies
  sync_repository
  prepare_runtime_env
  start_stack
  restore_backup_if_requested
  write_deploy_proof
  wait_for_health
  docker compose ps
  echo "disposable_dev_restore_ok sha=$(cat "$APP_DIR/DEPLOYED_GIT_SHA") app_dir=$APP_DIR host=$HOST_HEADER"
}

main "$@"
