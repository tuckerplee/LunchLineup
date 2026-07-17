#!/bin/bash
# Candidate-bound Dynamic Application Security Testing using OWASP ZAP.
set -euo pipefail

TARGET_URL="${1:-${TARGET_URL:-http://localhost}}"
SOURCE_SHA="${EXPECTED_SOURCE_SHA:-${SOURCE_SHA:-${GITHUB_SHA:-}}}"
ZAP_IMAGE="${ZAP_IMAGE:-}"
SOURCE_ROOT="$(pwd -P)"
TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
RULES_FILE="${ZAP_RULES_FILE:-.zap-rules.tsv}"

if [[ ! "$SOURCE_SHA" =~ ^[A-Fa-f0-9]{40}$ ]]; then
  echo "EXPECTED_SOURCE_SHA, SOURCE_SHA, or GITHUB_SHA must provide a 40-character candidate SHA." >&2
  exit 64
fi
SOURCE_SHA="${SOURCE_SHA,,}"
if [[ ! "$ZAP_IMAGE" =~ ^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$ ]]; then
  echo "ZAP_IMAGE must be an immutable name@sha256:<64hex> reference; mutable tags are rejected." >&2
  exit 64
fi
for command in docker curl node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to run candidate-bound DAST." >&2
    exit 127
  fi
done

mkdir -p "$TEMP_ROOT"
TEMP_ROOT="$(cd "$TEMP_ROOT" && pwd -P)"
if [[ -n "${DAST_OUTPUT_DIR:-}" ]]; then
  OUTPUT_DIR="$DAST_OUTPUT_DIR"
elif [[ -n "${RUNNER_TEMP:-}" ]]; then
  OUTPUT_DIR="$TEMP_ROOT/lunchlineup-candidate-dast/$SOURCE_SHA"
else
  OUTPUT_DIR="$(mktemp -d "$TEMP_ROOT/lunchlineup-candidate-dast-$SOURCE_SHA.XXXXXX")"
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"
case "$OUTPUT_DIR/" in
  "$TEMP_ROOT"/*/) ;;
  *) echo "DAST_OUTPUT_DIR must resolve to a dedicated directory below RUNNER_TEMP or the local temp root." >&2; exit 64 ;;
esac

RAW_REPORT_PATH="$OUTPUT_DIR/dast-zap-$SOURCE_SHA.json"
HTML_REPORT_PATH="$OUTPUT_DIR/dast-zap-$SOURCE_SHA.html"
EVIDENCE_PATH="$OUTPUT_DIR/dast-evidence-$SOURCE_SHA.json"
rm -f "$RAW_REPORT_PATH" "$HTML_REPORT_PATH" "$EVIDENCE_PATH"

rules_args=()
if [[ -f "$RULES_FILE" ]]; then
  RULES_PATH="$(cd "$(dirname "$RULES_FILE")" && pwd -P)/$(basename "$RULES_FILE")"
  case "$RULES_PATH" in
    "$SOURCE_ROOT"/*) rules_args=(-c "/workspace/${RULES_PATH#"$SOURCE_ROOT"/}") ;;
    *) echo "ZAP_RULES_FILE must resolve inside the source checkout." >&2; exit 64 ;;
  esac
fi

echo "Starting candidate-bound DAST scan against $TARGET_URL..."
set +e
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp/zap-home \
  --volume "$SOURCE_ROOT:/workspace:ro" \
  --volume "$OUTPUT_DIR:/zap/wrk:rw" \
  --workdir /zap/wrk \
  "$ZAP_IMAGE" \
  zap-baseline.py -t "$TARGET_URL" -r "$(basename "$HTML_REPORT_PATH")" -J "$(basename "$RAW_REPORT_PATH")" -a "${rules_args[@]}"
scan_exit=$?
headers="$(curl --fail --silent --show-error --location --head "$TARGET_URL" 2>/dev/null)"
header_exit=$?
set -e
served_release_sha="$(printf '%s\n' "$headers" | awk 'BEGIN { IGNORECASE=1 } /^X-LunchLineup-Release:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); sub(/\r$/, "", value); last=value } END { print last }')"
if [[ $header_exit -ne 0 ]]; then
  scan_exit=1
fi

set +e
node scripts/launch-proof-evidence.mjs emit dast \
  --source-sha "$SOURCE_SHA" \
  --target-url "$TARGET_URL" \
  --served-release-sha "$served_release_sha" \
  --tool-image "$ZAP_IMAGE" \
  --raw-report "$RAW_REPORT_PATH" \
  --raw-html "$HTML_REPORT_PATH" \
  --command-exit-code "$scan_exit" \
  --command "scripts/run-dast.sh $TARGET_URL" \
  --output "$EVIDENCE_PATH"
evidence_exit=$?
set -e
if [[ $evidence_exit -eq 0 ]]; then
  node scripts/launch-proof-evidence.mjs verify-bundle dast \
    --evidence "$EVIDENCE_PATH" \
    --raw-report "$RAW_REPORT_PATH" \
    --raw-html "$HTML_REPORT_PATH" \
    --expected-source-sha "$SOURCE_SHA" \
    --expected-tool-image "$ZAP_IMAGE" \
    --max-age-seconds 300
fi
printf 'dast_evidence_dir=%s\n' "$OUTPUT_DIR"
exit "$evidence_exit"
