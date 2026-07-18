#!/usr/bin/env bash
# scripts/bootstrap-vm107-dev.sh
# Bootstrap a fresh VM107-style LunchLineup dev host from GitHub, then optionally
# restore an existing Postgres dump. This script is for disposable private dev
# servers only; do not run it against current public production ProxmoxS VM4014.
# VM106 identifies only the historical legacy PHP source environment.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
REPO_URL="${REPO_URL:-https://github.com/tuckerplee/LunchLineup.git}"
BRANCH="${BRANCH:-migration-testing-baseline}"
SECRETS_DIR="${SECRETS_DIR:-/opt/lunchlineup-secrets}"
SECRET_ENV_PATH="${SECRET_ENV_PATH:-$SECRETS_DIR/runtime.env}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/health}"
HOST_HEADER="${HOST_HEADER:-dev.lunchlineup.com}"
VM_HOSTNAME="${VM_HOSTNAME:-lunchlineup-dev}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
BACKUP_FILE="${BACKUP_FILE:-}"
DESTRUCTIVE_CONFIRMATION="replace-and-restore-disposable-vm107"

services=(
  proxy web api webhook-replay engine worker control
  migrate pgbouncer postgres redis rabbitmq
  prometheus alertmanager node-exporter loki promtail otel-collector tempo grafana
  autoheal
)

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run as root or through sudo on the disposable dev VM." >&2
    exit 1
  fi
}

require_destructive_confirmation() {
  if [[ "${VM107_DESTRUCTIVE_CONFIRM:-}" != "$DESTRUCTIVE_CONFIRMATION" ]]; then
    echo "Set VM107_DESTRUCTIVE_CONFIRM=$DESTRUCTIVE_CONFIRMATION before replacing APP_DIR or restoring a backup." >&2
    exit 1
  fi
}

install_host_dependencies() {
  hostnamectl set-hostname "$VM_HOSTNAME"
  if grep -qE '^127\.0\.1\.1\s+' /etc/hosts; then
    sed -i "s/^127\.0\.1\.1\s\+.*/127.0.1.1 ${VM_HOSTNAME}/" /etc/hosts
  else
    printf "127.0.1.1 %s\n" "$VM_HOSTNAME" >> /etc/hosts
  fi

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
    require_destructive_confirmation
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

env_value() {
  local key="$1"
  grep -E "^${key}=" "$SECRET_ENV_PATH" | tail -n 1 | cut -d= -f2- || true
}

generated_secret() {
  openssl rand -hex "$1"
}
ensure_secret_file() {
  local name="$1"
  local value="$2"
  local path="$SECRETS_DIR/$name"

  if [[ ! -s "$path" ]]; then
    (umask 077; printf '%s\n' "$value" > "$path")
  fi
  chmod 600 "$path"
}

prepare_secret_files() {
  mkdir -p "$SECRETS_DIR"
  ensure_secret_file metrics_token "$(generated_secret 32)"
  ensure_secret_file control_plane_admin_token "$(generated_secret 32)"
  ensure_secret_file retention_purge_token "$(generated_secret 32)"
  ensure_secret_file backup_key "$(generated_secret 32)"
  ensure_secret_file alertmanager_webhook_url "${ALERTMANAGER_WEBHOOK_URL:-http://127.0.0.1:9/lunchlineup-dev}"
}

upsert_if_empty_or_placeholder() {
  local key="$1"
  local value="$2"
  local current
  current="$(env_value "$key")"
  if [[ -z "$current" || "$current" == change_me* || "$current" == "password" || "$current" == "guest" || "$current" == generate_with_* ]]; then
    upsert_env "$key" "$value"
  fi
}

prepare_runtime_env() {
  cd "$APP_DIR"

  if [[ ! -f "$SECRET_ENV_PATH" ]]; then
    cp .env.example "$SECRET_ENV_PATH"
    chmod 600 "$SECRET_ENV_PATH"
    upsert_env JWT_SECRET "$(generated_secret 64)"
    upsert_env JWT_REFRESH_SECRET "$(generated_secret 64)"
    upsert_env SESSION_SECRET "$(generated_secret 64)"
    upsert_env CSRF_SECRET "$(generated_secret 32)"
  fi

  chmod 600 "$SECRET_ENV_PATH"
  prepare_secret_files
  upsert_if_empty_or_placeholder POSTGRES_USER lunchlineup
  upsert_if_empty_or_placeholder POSTGRES_PASSWORD "$(generated_secret 24)"
  upsert_if_empty_or_placeholder POSTGRES_DB lunchlineup
  upsert_if_empty_or_placeholder APP_DB_USER lunchlineup_app
  upsert_if_empty_or_placeholder APP_DB_PASSWORD "$(generated_secret 24)"
  upsert_if_empty_or_placeholder RABBITMQ_USER lunchlineup
  upsert_if_empty_or_placeholder RABBITMQ_PASSWORD "$(generated_secret 24)"
  upsert_if_empty_or_placeholder GRAFANA_USER lunchlineup_admin
  upsert_if_empty_or_placeholder GRAFANA_PASSWORD "$(generated_secret 24)"
  upsert_if_empty_or_placeholder CONTROL_PLANE_PASSWORD "$(generated_secret 24)"
  upsert_if_empty_or_placeholder JWT_SECRET "$(generated_secret 64)"
  upsert_if_empty_or_placeholder JWT_REFRESH_SECRET "$(generated_secret 64)"
  upsert_if_empty_or_placeholder SESSION_SECRET "$(generated_secret 64)"
  upsert_if_empty_or_placeholder CSRF_SECRET "$(generated_secret 32)"
  upsert_if_empty_or_placeholder OTP_HMAC_SECRET "$(generated_secret 32)"
  upsert_if_empty_or_placeholder PLATFORM_ADMIN_DB_CONTEXT_SECRET "$(generated_secret 32)"
  upsert_if_empty_or_placeholder MFA_SECRET_ENCRYPTION_KEY_CURRENT "$(generated_secret 32)"
  upsert_if_empty_or_placeholder WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT "$(generated_secret 32)"
  upsert_if_empty_or_placeholder PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY "$(generated_secret 32)"
  upsert_if_empty_or_placeholder AVAILABILITY_IMPORT_ENCRYPTION_KEY "$(generated_secret 32)"
  upsert_if_empty_or_placeholder STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY "$(generated_secret 32)"
  upsert_if_empty_or_placeholder RESEND_API_KEY "${RESEND_API_KEY:-re_dev_$(generated_secret 24)}"
  upsert_if_empty_or_placeholder RESEND_WEBHOOK_SECRET "whsec_$(generated_secret 24)"
  upsert_if_empty_or_placeholder STRIPE_SECRET_KEY "sk_test_$(generated_secret 24)"
  upsert_if_empty_or_placeholder STRIPE_WEBHOOK_SECRET "whsec_$(generated_secret 24)"
  upsert_if_empty_or_placeholder STRIPE_METER_ERROR_WEBHOOK_SECRET "whsec_$(generated_secret 24)"
  upsert_if_empty_or_placeholder STRIPE_METER_ERROR_EVENT_DESTINATION_ID "ed_dev_$(generated_secret 12)"
  upsert_if_empty_or_placeholder STRIPE_METER_ID "mtr_dev_$(generated_secret 12)"

  local db_user db_pass db_name app_db_user app_db_pass rabbit_user rabbit_pass
  db_user="$(env_value POSTGRES_USER)"
  db_pass="$(env_value POSTGRES_PASSWORD)"
  db_name="$(env_value POSTGRES_DB)"
  app_db_user="$(env_value APP_DB_USER)"
  app_db_pass="$(env_value APP_DB_PASSWORD)"
  rabbit_user="$(env_value RABBITMQ_USER)"
  rabbit_pass="$(env_value RABBITMQ_PASSWORD)"

  upsert_env NODE_ENV development
  upsert_env DATA_TARGET_ENV disposable
  upsert_env DOMAIN "$HOST_HEADER"
  upsert_env CADDY_SITE_ADDRESSES "http://${HOST_HEADER}:80, http://lunchlineup-dev.proxmox1.lan:80, http://lunchlineup-dev-vm.proxmox1.lan:80, http://10.231.10.108:80, http://localhost:80, http://127.0.0.1:80, http://proxy:80"
  upsert_env PROXY_HTTP_BIND "0.0.0.0"
  upsert_env PROXY_HTTPS_BIND "127.0.0.1"
  upsert_env API_HOST_BIND "127.0.0.1"
  upsert_env API_HOST_PORT "4000"
  upsert_env DATABASE_URL "postgresql://${app_db_user}:${app_db_pass}@postgres:5432/${db_name}"
  upsert_env MIGRATION_DATABASE_URL "postgresql://${db_user}:${db_pass}@postgres:5432/${db_name}"
  upsert_env REDIS_URL "redis://redis:6379"
  upsert_env RABBITMQ_URL "amqp://${rabbit_user}:${rabbit_pass}@rabbitmq:5672"
  upsert_env METRICS_TOKEN_FILE "$SECRETS_DIR/metrics_token"
  upsert_env RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE "$SECRETS_DIR/retention_purge_token"
  upsert_env CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE "$SECRETS_DIR/control_plane_admin_token"
  upsert_env CONTROL_PLANE_ADMIN_TOKEN_FILE "/run/secrets/control_plane_admin_token"
  upsert_env CONTROL_PLANE_METRICS_TOKEN_FILE "/run/secrets/metrics_token"
  upsert_env ALERTMANAGER_WEBHOOK_URL_FILE "$SECRETS_DIR/alertmanager_webhook_url"
  upsert_env BACKUP_ENCRYPTION_KEY_SECRET_FILE "$SECRETS_DIR/backup_key"
  upsert_env STRIPE_METER_AGGREGATION "last"
  upsert_env STRIPE_METERED_USAGE_ENABLED "false"
  upsert_env PASSWORD_RESET_EMAIL_OUTBOX_ENABLED "true"
  upsert_env STAFF_INVITATION_OUTBOX_ENABLED "true"
  upsert_env APP_ORIGIN "http://${HOST_HEADER}"
  upsert_env NEXT_PUBLIC_APP_ORIGIN "http://${HOST_HEADER}"
  upsert_env NEXT_PUBLIC_APP_URL "http://${HOST_HEADER}"
  upsert_env NEXT_PUBLIC_APP_ENV "development"
  upsert_env NEXT_PUBLIC_API_URL "/api/v1"
  upsert_env INTERNAL_API_URL "http://api:3000/v1"
  upsert_env LUNCHLINEUP_STATUS_HEALTH_URL "http://api:3000/health"
  upsert_env NEXT_PUBLIC_OIDC_ENABLED false
  upsert_env OIDC_ENABLED false
  upsert_env COOKIE_SECURE false
  upsert_env ALLOWED_HOSTS "10.231.10.108,10.231.10.108:80,${HOST_HEADER},lunchlineup-dev.proxmox1.lan,lunchlineup-dev-vm.proxmox1.lan"
  upsert_env ALLOWED_ORIGINS "http://10.231.10.108,http://${HOST_HEADER},http://lunchlineup-dev.proxmox1.lan,http://lunchlineup-dev-vm.proxmox1.lan"
  upsert_env EMAIL_FROM "${EMAIL_FROM:-LunchLineup Dev <no-reply@dev.lunchlineup.com>}"

  ln -sfn "$SECRET_ENV_PATH" .env
}

start_stack() {
  cd "$APP_DIR"
  docker compose --env-file "$SECRET_ENV_PATH" config --quiet
  if ! docker compose --env-file "$SECRET_ENV_PATH" up -d --build "${services[@]}"; then
    echo "Initial Compose startup failed; waiting for dependency health and retrying once." >&2
    docker compose ps >&2 || true
    sleep 30
    docker compose --env-file "$SECRET_ENV_PATH" up -d --build "${services[@]}"
  fi
}

restore_backup_if_requested() {
  if [[ -z "$BACKUP_FILE" ]]; then
    return
  fi
  if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "BACKUP_FILE does not exist: $BACKUP_FILE" >&2
    exit 1
  fi

  require_destructive_confirmation
  echo "Restoring Postgres data from $BACKUP_FILE"
  case "$BACKUP_FILE" in
    *.sql)
      docker compose --env-file "$SECRET_ENV_PATH" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$(env_value POSTGRES_USER)" -d "$(env_value POSTGRES_DB)" < "$BACKUP_FILE"
      ;;
    *.sql.zst)
      zstd -d -c "$BACKUP_FILE" | docker compose --env-file "$SECRET_ENV_PATH" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$(env_value POSTGRES_USER)" -d "$(env_value POSTGRES_DB)"
      ;;
    *.sql.zst.gpg)
      if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
        echo "BACKUP_ENCRYPTION_KEY is required for encrypted backups." >&2
        exit 1
      fi
      gpg --decrypt --batch --passphrase "$BACKUP_ENCRYPTION_KEY" "$BACKUP_FILE" \
        | zstd -d -c \
        | docker compose --env-file "$SECRET_ENV_PATH" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$(env_value POSTGRES_USER)" -d "$(env_value POSTGRES_DB)"
      ;;
    *)
      echo "Unsupported BACKUP_FILE format. Use .sql, .sql.zst, or .sql.zst.gpg." >&2
      exit 1
      ;;
  esac

  docker compose --env-file "$SECRET_ENV_PATH" run --rm migrate
  docker compose --env-file "$SECRET_ENV_PATH" up -d api webhook-replay worker
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
  if [[ ! -d "$APP_DIR/.git" || -n "$BACKUP_FILE" ]]; then
    require_destructive_confirmation
  fi
  install_host_dependencies
  sync_repository
  prepare_runtime_env
  start_stack
  restore_backup_if_requested
  wait_for_health
  write_deploy_proof
  docker compose ps
  echo "disposable_dev_restore_ok sha=$(cat "$APP_DIR/DEPLOYED_GIT_SHA") app_dir=$APP_DIR host=$HOST_HEADER hostname=$(hostname)"
}

main "$@"
