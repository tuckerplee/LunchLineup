#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_KEY="${SSH_KEY:-$ROOT_DIR/secrets/vm217/lunchlineup-vm217}"
REMOTE_USER="${REMOTE_USER:-lunchlineup}"
REMOTE_HOST="${REMOTE_HOST:-10.10.10.141}"
REMOTE_PATH="${REMOTE_PATH:-/opt/lunchlineup/}"

if [[ ! -f "$SSH_KEY" ]]; then
  echo "SSH key not found: $SSH_KEY" >&2
  exit 1
fi

chmod 600 "$SSH_KEY"

rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'apps/web/playwright-report' \
  --exclude 'apps/web/test-results' \
  --exclude 'old' \
  --exclude '*.tsbuildinfo' \
  --exclude 'apps/api/src/**/*.spec.ts' \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  "$ROOT_DIR/" \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"

echo "Rsync complete: $REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"
