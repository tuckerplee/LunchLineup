#!/usr/bin/env bash
set -euo pipefail

DRIVER=""
CLONE_ENV=""
CLONE_ID=""
PRODUCTION_RUNTIME_ENV=""
TIMEOUT_SECONDS=""

fail() {
  echo "$1" >&2
  exit 64
}

while (( $# > 0 )); do
  case "$1" in
    --driver) DRIVER="${2:-}"; shift 2 ;;
    --clone-env) CLONE_ENV="${2:-}"; shift 2 ;;
    --clone-id) CLONE_ID="${2:-}"; shift 2 ;;
    --production-runtime-env) PRODUCTION_RUNTIME_ENV="${2:-}"; shift 2 ;;
    --timeout-seconds) TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    *) fail "Unknown clone-destroy option: $1" ;;
  esac
done

[[ -n "$DRIVER" && -f "$DRIVER" && ! -L "$DRIVER" && -x "$DRIVER" ]] \
  || fail "Compatibility clone destroy driver must be an executable regular file."
[[ -n "$CLONE_ENV" && "$CLONE_ENV" != *$'\n'* && "$CLONE_ENV" != *$'\r'* ]] \
  || fail "Compatibility clone environment path must be single-line."
[[ "$CLONE_ID" =~ ^llc-[A-Za-z0-9-]+$ ]] \
  || fail "Compatibility clone ID is invalid."
[[ "$PRODUCTION_RUNTIME_ENV" != *$'\n'* && "$PRODUCTION_RUNTIME_ENV" != *$'\r'* ]] \
  || fail "Production runtime environment path must be single-line."
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] && (( TIMEOUT_SECONDS <= 600 )) \
  || fail "Compatibility clone destroy timeout must be an integer from 1 through 600."
command -v timeout >/dev/null 2>&1 || fail "timeout is required for compatibility clone cleanup."

destroy_status=0
OLD_RELEASE_COMPATIBILITY_CLONE_OPERATION=destroy \
  OLD_RELEASE_COMPATIBILITY_CLONE_ID="$CLONE_ID" \
  OLD_RELEASE_COMPATIBILITY_CLONE_ENV_PATH="$CLONE_ENV" \
  OLD_RELEASE_COMPATIBILITY_PRODUCTION_RUNTIME_ENV_PATH="$PRODUCTION_RUNTIME_ENV" \
  timeout --foreground --signal=TERM --kill-after=5s "${TIMEOUT_SECONDS}s" "$DRIVER" \
  || destroy_status=$?

if (( destroy_status != 0 )); then
  echo "Compatibility clone destroy failed with status $destroy_status; preserving the driver and clone environment for the always-run retry." >&2
  exit "$destroy_status"
fi

rm -f -- "$CLONE_ENV" "$DRIVER"
echo "compatibility_clone_destroyed clone_id=$CLONE_ID"
