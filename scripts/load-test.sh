#!/bin/bash
# scripts/load-test.sh
# Load testing using Artillery.
# Architecture Part IX.
set -euo pipefail

TARGET_URL="${1:-${TARGET_URL:-http://localhost}}"
SCENARIO_PATH="${SCENARIO_PATH:-scripts/artillery-smoke.yml}"

if [[ ! -f "$SCENARIO_PATH" ]]; then
  echo "Artillery scenario not found: $SCENARIO_PATH" >&2
  exit 1
fi

echo "Running Artillery smoke load test against $TARGET_URL..."
TARGET_URL="$TARGET_URL" npx --yes artillery@2 run "$SCENARIO_PATH"
