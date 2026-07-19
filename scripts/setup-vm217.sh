#!/usr/bin/env bash
set -euo pipefail

VM_HOST="${VM_HOST:-10.10.10.141}"
VM_USER="${VM_USER:-lunchlineup}"
SSH_KEY="${SSH_KEY:-$PWD/secrets/vm217/lunchlineup-vm217}"
APP_DIR="${APP_DIR:-/opt/lunchlineup}"
REPO_URL="${REPO_URL:-https://github.com/tuckerplee/LunchLineup.git}"
BRANCH="${BRANCH:-main}"
VM217_DEPLOY_SCOPE="${VM217_DEPLOY_SCOPE:-}"

if [[ "$VM217_DEPLOY_SCOPE" != "development" ]]; then
  echo "Refusing VM217 setup outside development. Production VM217 deploys must use release-manifest artifacts, RELEASE_SOURCE_SHA, post-deploy health, and launch-proof gates." >&2
  echo "Set VM217_DEPLOY_SCOPE=development only for disposable/dev VM217 bootstrap." >&2
  exit 1
fi

if [[ ! -f "$SSH_KEY" ]]; then
  echo "SSH key not found at: $SSH_KEY" >&2
  exit 1
fi

chmod 600 "$SSH_KEY"

SSH_OPTS=(
  -i "$SSH_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=10
)

echo "Checking SSH connectivity to ${VM_USER}@${VM_HOST}..."
ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_HOST}" "echo connected: \\$(hostname)" >/dev/null

echo "Bootstrapping host dependencies (git, docker, compose plugin)..."
ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_HOST}" 'bash -s' <<'REMOTE'
set -euo pipefail

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required on remote host" >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git

if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

sudo usermod -aG docker "$USER" || true
sudo mkdir -p /opt
sudo chown "$USER":"$USER" /opt
# Free up :80 for Caddy if a host nginx service is present.
sudo systemctl disable --now nginx || true
REMOTE

echo "Cloning/updating repository on server..."
ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_HOST}" APP_DIR="${APP_DIR}" REPO_URL="${REPO_URL}" BRANCH="${BRANCH}" 'bash -s' <<'REMOTE'
set -euo pipefail
if [[ ! -d "${APP_DIR}/.git" ]]; then
  git clone "${REPO_URL}" "${APP_DIR}"
fi
cd "${APP_DIR}"
git fetch origin
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  git checkout "${BRANCH}"
else
  git checkout -b "${BRANCH}" "origin/${BRANCH}"
fi
git pull --ff-only origin "${BRANCH}"

if [[ ! -f .env ]]; then
  cp .env.example .env
  # Generate production-safe defaults for local secrets; replace with real provider values.
  JWT_SECRET=$(openssl rand -hex 64)
  JWT_REFRESH_SECRET=$(openssl rand -hex 64)
  SESSION_SECRET=$(openssl rand -hex 64)
  CSRF_SECRET=$(openssl rand -hex 32)
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  RABBITMQ_PASSWORD=$(openssl rand -hex 24)
  GRAFANA_PASSWORD=$(openssl rand -hex 24)
  CONTROL_PLANE_PASSWORD=$(openssl rand -hex 24)
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" .env
  sed -i "s|^DOMAIN=.*|DOMAIN=beta.lunchlineup.com|" .env
  sed -i "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=admin@lunchlineup.com|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" .env
  sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}|" .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" .env
  sed -i "s|^CSRF_SECRET=.*|CSRF_SECRET=${CSRF_SECRET}|" .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" .env
  sed -i "s|^RABBITMQ_PASSWORD=.*|RABBITMQ_PASSWORD=${RABBITMQ_PASSWORD}|" .env
  sed -i "s|^GRAFANA_PASSWORD=.*|GRAFANA_PASSWORD=${GRAFANA_PASSWORD}|" .env
  sed -i "s|^CONTROL_PLANE_PASSWORD=.*|CONTROL_PLANE_PASSWORD=${CONTROL_PLANE_PASSWORD}|" .env
fi

# Force container-to-container endpoints for Compose networking.
# Keep DATABASE_URL aligned with POSTGRES_* values in .env.
DB_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || true)
DB_PASS=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2- || true)
DB_NAME=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- || true)
RABBIT_USER=$(grep -E '^RABBITMQ_USER=' .env | cut -d= -f2- || true)
RABBIT_PASS=$(grep -E '^RABBITMQ_PASSWORD=' .env | cut -d= -f2- || true)
GRAFANA_PASS=$(grep -E '^GRAFANA_PASSWORD=' .env | cut -d= -f2- || true)
CONTROL_PASS=$(grep -E '^CONTROL_PLANE_PASSWORD=' .env | cut -d= -f2- || true)
DB_USER=${DB_USER:-lunchlineup}
if [[ -z "$DB_PASS" || "$DB_PASS" == change_me* || "$DB_PASS" == "password" ]]; then
  DB_PASS=$(openssl rand -hex 24)
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${DB_PASS}|" .env
fi
DB_NAME=${DB_NAME:-lunchlineup}
RABBIT_USER=${RABBIT_USER:-lunchlineup}
if [[ -z "$RABBIT_PASS" || "$RABBIT_PASS" == change_me* || "$RABBIT_PASS" == "guest" ]]; then
  RABBIT_PASS=$(openssl rand -hex 24)
  sed -i "s|^RABBITMQ_PASSWORD=.*|RABBITMQ_PASSWORD=${RABBIT_PASS}|" .env
fi
if [[ -z "$GRAFANA_PASS" || "$GRAFANA_PASS" == change_me* ]]; then
  GRAFANA_PASS=$(openssl rand -hex 24)
  if grep -q "^GRAFANA_PASSWORD=" .env; then
    sed -i "s|^GRAFANA_PASSWORD=.*|GRAFANA_PASSWORD=${GRAFANA_PASS}|" .env
  else
    printf "GRAFANA_PASSWORD=%s\n" "$GRAFANA_PASS" >> .env
  fi
fi
if [[ -z "$CONTROL_PASS" || "$CONTROL_PASS" == change_me* ]]; then
  CONTROL_PASS=$(openssl rand -hex 24)
  if grep -q "^CONTROL_PLANE_PASSWORD=" .env; then
    sed -i "s|^CONTROL_PLANE_PASSWORD=.*|CONTROL_PLANE_PASSWORD=${CONTROL_PASS}|" .env
  else
    printf "CONTROL_PLANE_PASSWORD=%s\n" "$CONTROL_PASS" >> .env
  fi
fi
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@postgres:5432/${DB_NAME}|" .env
sed -i "s|^REDIS_URL=.*|REDIS_URL=redis://redis:6379|" .env
sed -i "s|^RABBITMQ_URL=.*|RABBITMQ_URL=amqp://${RABBIT_USER}:${RABBIT_PASS}@rabbitmq:5672|" .env
sed -i "s|^NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=/api/v1|" .env
sed -i "s|^INTERNAL_API_URL=.*|INTERNAL_API_URL=http://api:3000/v1|" .env
sed -i "s|^INTERNAL_API_V2_URL=.*|INTERNAL_API_V2_URL=http://api-v2:3002/v2|" .env
sed -i "s|^OIDC_REDIRECT_URI=.*|OIDC_REDIRECT_URI=https://beta.lunchlineup.com/api/v1/auth/callback|" .env
if grep -q "^CADDY_SITE_ADDRESSES=" .env; then
  sed -i "s|^CADDY_SITE_ADDRESSES=.*|CADDY_SITE_ADDRESSES=https://beta.lunchlineup.com, https://www.beta.lunchlineup.com, http://10.10.10.141:80, http://localhost:80, http://127.0.0.1:80, http://proxy:80|" .env
else
  printf "CADDY_SITE_ADDRESSES=https://beta.lunchlineup.com, https://www.beta.lunchlineup.com, http://10.10.10.141:80, http://localhost:80, http://127.0.0.1:80, http://proxy:80\n" >> .env
fi
if grep -q "^OIDC_ENABLED=" .env; then
  sed -i "s|^OIDC_ENABLED=.*|OIDC_ENABLED=false|" .env
else
  printf "OIDC_ENABLED=false\n" >> .env
fi
if grep -q "^ALLOWED_ORIGINS=" .env; then
  sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://beta.lunchlineup.com,https://www.beta.lunchlineup.com,http://10.10.10.141|" .env
else
  printf "ALLOWED_ORIGINS=https://beta.lunchlineup.com,https://www.beta.lunchlineup.com,http://10.10.10.141\n" >> .env
fi
if grep -q "^ALLOWED_HOSTS=" .env; then
  sed -i "s|^ALLOWED_HOSTS=.*|ALLOWED_HOSTS=10.10.10.141,10.10.10.141:80,beta.lunchlineup.com,www.beta.lunchlineup.com|" .env
else
  printf "ALLOWED_HOSTS=10.10.10.141,10.10.10.141:80,beta.lunchlineup.com,www.beta.lunchlineup.com\n" >> .env
fi

# Email provider wiring:
# - If RESEND_API_KEY is provided to this script, apply it.
# - Otherwise preserve any existing key and leave the value empty so production
#   startup fails closed until a real provider key is supplied.
if [[ -n "${RESEND_API_KEY:-}" ]]; then
  if grep -q "^RESEND_API_KEY=" .env; then
    sed -i "s|^RESEND_API_KEY=.*|RESEND_API_KEY=${RESEND_API_KEY}|" .env
  else
    printf "\nRESEND_API_KEY=%s\n" "${RESEND_API_KEY}" >> .env
  fi
elif ! grep -q "^RESEND_API_KEY=" .env; then
  printf "\nRESEND_API_KEY=\n" >> .env
  echo "RESEND_API_KEY is required for production email OTP delivery." >&2
fi

# Default sender for beta if not already configured.
if [[ -n "${EMAIL_FROM:-}" ]]; then
  if grep -q "^EMAIL_FROM=" .env; then
    sed -i "s|^EMAIL_FROM=.*|EMAIL_FROM=${EMAIL_FROM}|" .env
  else
    printf "EMAIL_FROM=%s\n" "${EMAIL_FROM}" >> .env
  fi
elif ! grep -q "^EMAIL_FROM=" .env; then
  printf "EMAIL_FROM=LunchLineup Beta <no-reply@beta.lunchlineup.com>\n" >> .env
fi

docker compose pull || true
docker compose up -d --build proxy web api api-v2 engine worker migrate pgbouncer postgres redis rabbitmq prometheus loki promtail otel-collector tempo grafana autoheal
git rev-parse HEAD > DEPLOYED_GIT_SHA
REMOTE

echo "Deployment command completed." 
