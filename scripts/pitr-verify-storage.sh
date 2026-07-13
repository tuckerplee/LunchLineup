#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
COMPOSE_SERVICE_ENV_FILE="${COMPOSE_SERVICE_ENV_FILE:?COMPOSE_SERVICE_ENV_FILE is required}"
IMAGE_PREFIX="${IMAGE_PREFIX:?IMAGE_PREFIX is required}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
export IMAGE_PREFIX IMAGE_TAG

compose=(docker compose --project-directory "$APP_DIR" --profile ops --env-file "$COMPOSE_SERVICE_ENV_FILE")
"${compose[@]}" run --rm --no-deps --pull never pitr-tools
"${compose[@]}" run --rm --no-deps --pull never --entrypoint /bin/sh postgres \
  /opt/lunchlineup/pitr/pitr-verify-object-store.sh wal
"${compose[@]}" run --rm --no-deps --pull never --entrypoint /bin/sh pitr-base-backup \
  /opt/lunchlineup/infrastructure/postgres/pitr-verify-object-store.sh base-backup

printf 'pitr_storage_readiness_ok writers=wal,base-backup delete=denied object_lock=compliance\n'
