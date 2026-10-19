#!/bin/sh
# One-shot retention scheduler runner for hosts with no Node.js (VM107).
# Runs scripts/invoke-retained-record-purge.mjs inside the already-deployed
# migrate image through the profile-gated `retention-scheduler` Compose service.
# Called by lunchlineup-retention-purge.service and
# lunchlineup-retained-record-review.service under the deploy flock; it reads
# RETENTION_PURGE_* values from its environment (set by the unit) and forwards
# them to the container. Nothing is built, started, or pulled by `up`.
set -eu

ROOT="${LUNCHLINEUP_ROOT:-/opt/lunchlineup}"
E="${LUNCHLINEUP_RUNTIME_ENV:-/opt/lunchlineup-secrets/runtime.env}"

[ -r "$E" ] || { echo "runtime env not readable: $E" >&2; exit 1; }
cd "$ROOT"

# Read (never source) the single flag that selects the optional pgBackRest overlay.
pgbackrest="$(sed -n 's/^PGBACKREST_ENABLED=//p' "$E" | tail -n 1 | tr -d '"'"'"' \r')"

set -- docker compose --project-name lunchlineup --project-directory "$ROOT" --env-file "$E" \
  -f docker-compose.yml -f infrastructure/development-admission/compose.private-proxy.yml
if [ "$pgbackrest" = "true" ]; then
  set -- "$@" -f infrastructure/postgres/compose.pgbackrest.yml
fi

set -- "$@" run --rm --no-deps -T
for name in RETENTION_PURGE_STAGE RETENTION_PURGE_DRY_RUN RETENTION_PURGE_EXECUTE_CONFIRM \
  RETENTION_PURGE_PROOF_FILE RETENTION_PURGE_METRICS_FILE RETENTION_PURGE_LOCK_FILE; do
  eval "value=\${$name-}"
  if [ -n "$value" ]; then
    set -- "$@" -e "$name=$value"
  fi
done
set -- "$@" retention-scheduler

COMPOSE_SERVICE_ENV_FILE="$E" exec "$@"
