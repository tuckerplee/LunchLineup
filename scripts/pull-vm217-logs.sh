#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_KEY="${SSH_KEY:-$ROOT_DIR/secrets/vm217/lunchlineup-vm217}"
REMOTE_USER="${REMOTE_USER:-lunchlineup}"
REMOTE_HOST="${REMOTE_HOST:-10.10.10.141}"
REMOTE_PATH="${REMOTE_PATH:-/opt/lunchlineup}"
SERVICE="${1:-all}"
TAIL="${TAIL:-300}"
MATCH="${MATCH:-}"

if [[ ! -f "$SSH_KEY" ]]; then
  echo "SSH key not found: $SSH_KEY" >&2
  exit 1
fi

chmod 600 "$SSH_KEY"

build_cmd() {
  local svc="$1"
  cat <<EOF
cd "$REMOTE_PATH"
docker ps --format 'table {{.Names}}\t{{.Status}}'
echo
echo "===== ${svc} logs (tail=${TAIL}) ====="
docker logs "lunchlineup-${svc}" --tail "${TAIL}" 2>&1
EOF
}

if [[ "$SERVICE" == "all" ]]; then
  CMD="$(build_cmd web)"
  CMD+=$'\n\n'
  CMD+="$(build_cmd api)"
else
  CMD="$(build_cmd "$SERVICE")"
fi

if [[ -n "$MATCH" ]]; then
  CMD+=$'\n\n'
  CMD+="echo \"===== filtered (${MATCH}) =====\""
  CMD+=$'\n'
  CMD+="(docker logs lunchlineup-web --tail \"${TAIL}\" 2>&1; docker logs lunchlineup-api --tail \"${TAIL}\" 2>&1) | grep -E \"${MATCH}\" || true"
fi

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$REMOTE_USER@$REMOTE_HOST" "$CMD"
