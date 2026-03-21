#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "${SSH_KEY:-}" ]]; then
  RESOLVED_SSH_KEY="$SSH_KEY"
else
  CANDIDATE_KEYS=(
    "$ROOT_DIR/secrets/vm217/lunchlineup-vm217"
    "$HOME/Desktop/Projects/Entrypin/usb2go/hosts/lunchlineup/vm217/lunchlineup-vm217"
  )
  RESOLVED_SSH_KEY=""
  for key in "${CANDIDATE_KEYS[@]}"; do
    if [[ -f "$key" ]]; then
      RESOLVED_SSH_KEY="$key"
      break
    fi
  done
fi

REMOTE_USER="${REMOTE_USER:-lunchlineup}"
REMOTE_HOST="${REMOTE_HOST:-10.10.10.141}"
REMOTE_PATH="${REMOTE_PATH:-/opt/lunchlineup/}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/api/health}"

if [[ -z "$RESOLVED_SSH_KEY" || ! -f "$RESOLVED_SSH_KEY" ]]; then
  echo "SSH key not found. Set SSH_KEY or place key at one of:" >&2
  echo "  - $ROOT_DIR/secrets/vm217/lunchlineup-vm217" >&2
  echo "  - $HOME/Desktop/Projects/Entrypin/usb2go/hosts/lunchlineup/vm217/lunchlineup-vm217" >&2
  exit 1
fi

chmod 600 "$RESOLVED_SSH_KEY"

rsync -az --delete \
  --filter='P .env' \
  --filter='P .env.*' \
  --exclude '.git' \
  --exclude '.git/***' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'apps/web/playwright-report' \
  --exclude 'apps/web/test-results' \
  --exclude 'old' \
  --exclude '*.tsbuildinfo' \
  --exclude 'backups' \
  --exclude 'backup' \
  -e "ssh -i $RESOLVED_SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
  "$ROOT_DIR/" \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"

echo "Rsync complete: $REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"

ssh -i "$RESOLVED_SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
  "$REMOTE_USER@$REMOTE_HOST" \
  "APP_DIR=${REMOTE_PATH%/} HEALTH_URL=${HEALTH_URL} /opt/lunchlineup/scripts/deploy-vm217-remote.sh"

echo "Remote deploy complete"
