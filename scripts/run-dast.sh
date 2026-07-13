#!/bin/bash
# scripts/run-dast.sh
# Dynamic Application Security Testing using OWASP ZAP.
# Architecture Part VII-A.
set -euo pipefail

TARGET_URL="${1:-${TARGET_URL:-http://localhost}}"
REPORT_PATH="${REPORT_PATH:-zap-report.html}"
RULES_FILE="${ZAP_RULES_FILE:-.zap-rules.tsv}"
ZAP_IMAGE="${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}"

echo "Starting DAST scan against $TARGET_URL..."

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run the ZAP baseline scan." >&2
  exit 127
fi

args=(zap-baseline.py -t "$TARGET_URL" -r "$REPORT_PATH" -a)
if [[ -f "$RULES_FILE" ]]; then
  args+=(-c "$RULES_FILE")
fi

docker run --rm -v "$PWD:/zap/wrk/:rw" -t "$ZAP_IMAGE" "${args[@]}"
