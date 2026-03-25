#!/usr/bin/env bash
set -euo pipefail

VM_HOST="${VM_HOST:-10.10.10.141}"
VM_USER="${VM_USER:-lunchlineup}"
SSH_KEY="${SSH_KEY:-$PWD/secrets/vm217/lunchlineup-vm217}"
APP_DIR="${APP_DIR:-/opt/lunchlineup}"
REPO_URL="${REPO_URL:-https://github.com/tuckerplee/LunchLineup.git}"
BRANCH="${BRANCH:-master}"

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
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" .env
  sed -i "s|^DOMAIN=.*|DOMAIN=beta.lunchlineup.com|" .env
  sed -i "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=admin@lunchlineup.com|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" .env
  sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}|" .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" .env
  sed -i "s|^CSRF_SECRET=.*|CSRF_SECRET=${CSRF_SECRET}|" .env
fi

# Force container-to-container endpoints for Compose networking.
# Keep DATABASE_URL aligned with POSTGRES_* values in .env.
DB_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || true)
DB_PASS=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2- || true)
DB_NAME=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- || true)
DB_USER=${DB_USER:-root}
DB_PASS=${DB_PASS:-password}
DB_NAME=${DB_NAME:-lunchlineup}
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@postgres:5432/${DB_NAME}|" .env
sed -i "s|^REDIS_URL=.*|REDIS_URL=redis://redis:6379|" .env
sed -i "s|^RABBITMQ_URL=.*|RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672|" .env
sed -i "s|^NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=/api/v1|" .env
sed -i "s|^OIDC_REDIRECT_URI=.*|OIDC_REDIRECT_URI=https://beta.lunchlineup.com/api/v1/auth/callback|" .env
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
# - Otherwise preserve any existing key and only fall back to placeholder when unset.
if [[ -n "${RESEND_API_KEY:-}" ]]; then
  if grep -q "^RESEND_API_KEY=" .env; then
    sed -i "s|^RESEND_API_KEY=.*|RESEND_API_KEY=${RESEND_API_KEY}|" .env
  else
    printf "\nRESEND_API_KEY=%s\n" "${RESEND_API_KEY}" >> .env
  fi
elif ! grep -q "^RESEND_API_KEY=" .env; then
  printf "\nRESEND_API_KEY=placeholder_resend_key\n" >> .env
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
# Skip control service for now because docker-compose.yml maps host port 3001 in two services.
docker compose up -d --build proxy web api engine worker pgbouncer postgres redis rabbitmq prometheus loki tempo grafana autoheal
# Ensure DB schema exists before first login attempts.
docker exec lunchlineup-api npx prisma db push --schema /app/packages/db/prisma/schema.prisma
REMOTE

echo "Deployment command completed." 
