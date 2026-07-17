#!/bin/bash
# Candidate-bound Artillery and availability-import load evidence.
set -euo pipefail

TARGET_URL="${1:-${TARGET_URL:-http://localhost}}"
export TARGET_URL
SOURCE_SHA="${EXPECTED_SOURCE_SHA:-${SOURCE_SHA:-${GITHUB_SHA:-}}}"
ARTILLERY_IMAGE="${ARTILLERY_IMAGE:-artilleryio/artillery:2.0.33@sha256:ee382d480f5cb8473c52fe94cb8e1505a9564ce2accbc94114098e0be06dff56}"
SCENARIO_PATH="${SCENARIO_PATH:-scripts/artillery-smoke.yml}"
SOURCE_ROOT="$(pwd -P)"
TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

if [[ ! "$SOURCE_SHA" =~ ^[A-Fa-f0-9]{40}$ ]]; then
  echo "EXPECTED_SOURCE_SHA, SOURCE_SHA, or GITHUB_SHA must provide a 40-character candidate SHA." >&2
  exit 64
fi
SOURCE_SHA="${SOURCE_SHA,,}"
if [[ ! "$ARTILLERY_IMAGE" =~ ^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$ ]]; then
  echo "ARTILLERY_IMAGE must be an immutable name@sha256:<64hex> reference." >&2
  exit 64
fi
for command in docker curl node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required for candidate-bound load evidence." >&2
    exit 127
  fi
done
if [[ ! -f "$SCENARIO_PATH" ]]; then
  echo "Artillery scenario not found: $SCENARIO_PATH" >&2
  exit 1
fi
SCENARIO_PATH="$(cd "$(dirname "$SCENARIO_PATH")" && pwd -P)/$(basename "$SCENARIO_PATH")"
case "$SCENARIO_PATH" in
  "$SOURCE_ROOT"/*) CONTAINER_SCENARIO_PATH="/workspace/${SCENARIO_PATH#"$SOURCE_ROOT"/}" ;;
  *) echo "SCENARIO_PATH must resolve inside the source checkout." >&2; exit 64 ;;
esac

mkdir -p "$TEMP_ROOT"
TEMP_ROOT="$(cd "$TEMP_ROOT" && pwd -P)"
if [[ -n "${LOAD_OUTPUT_DIR:-}" ]]; then
  OUTPUT_DIR="$LOAD_OUTPUT_DIR"
elif [[ -n "${RUNNER_TEMP:-}" ]]; then
  OUTPUT_DIR="$TEMP_ROOT/lunchlineup-candidate-load/$SOURCE_SHA"
else
  OUTPUT_DIR="$(mktemp -d "$TEMP_ROOT/lunchlineup-candidate-load-$SOURCE_SHA.XXXXXX")"
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"
case "$OUTPUT_DIR/" in
  "$TEMP_ROOT"/*/) ;;
  *) echo "LOAD_OUTPUT_DIR must resolve to a dedicated directory below RUNNER_TEMP or the local temp root." >&2; exit 64 ;;
esac

ARTILLERY_REPORT_PATH="$OUTPUT_DIR/load-artillery-$SOURCE_SHA.json"
AVAILABILITY_IMPORT_RESULT_PATH="$OUTPUT_DIR/load-availability-$SOURCE_SHA.json"
EVIDENCE_PATH="$OUTPUT_DIR/load-evidence-$SOURCE_SHA.json"
rm -f "$ARTILLERY_REPORT_PATH" "$AVAILABILITY_IMPORT_RESULT_PATH" "$EVIDENCE_PATH"

echo "Running candidate-bound Artillery smoke load test against $TARGET_URL..."
set +e
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp/artillery-home \
  --network host \
  --volume "$SOURCE_ROOT:/workspace:ro" \
  --volume "$OUTPUT_DIR:/output:rw" \
  --workdir /output \
  --env TARGET_URL \
  "$ARTILLERY_IMAGE" \
  run --output "/output/$(basename "$ARTILLERY_REPORT_PATH")" "$CONTAINER_SCENARIO_PATH"
artillery_exit=$?
if [[ $artillery_exit -eq 0 ]]; then
  AVAILABILITY_IMPORT_EVIDENCE_PATH="$AVAILABILITY_IMPORT_RESULT_PATH" node scripts/availability-import-load-smoke.mjs
  availability_exit=$?
else
  availability_exit=1
fi
headers="$(curl --fail --silent --show-error --location --head "$TARGET_URL" 2>/dev/null)"
header_exit=$?
set -e
served_release_sha="$(printf '%s\n' "$headers" | awk 'BEGIN { IGNORECASE=1 } /^X-LunchLineup-Release:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); sub(/\r$/, "", value); last=value } END { print last }')"
command_exit=0
if [[ $artillery_exit -ne 0 || $availability_exit -ne 0 || $header_exit -ne 0 ]]; then
  command_exit=1
fi

set +e
node scripts/launch-proof-evidence.mjs emit load \
  --source-sha "$SOURCE_SHA" \
  --target-url "$TARGET_URL" \
  --served-release-sha "$served_release_sha" \
  --tool-image "$ARTILLERY_IMAGE" \
  --raw-result "$ARTILLERY_REPORT_PATH" \
  --availability-result "$AVAILABILITY_IMPORT_RESULT_PATH" \
  --command-exit-code "$command_exit" \
  --command "scripts/load-test.sh $TARGET_URL" \
  --output "$EVIDENCE_PATH"
evidence_exit=$?
set -e
if [[ $evidence_exit -eq 0 ]]; then
  node scripts/launch-proof-evidence.mjs verify-bundle load \
    --evidence "$EVIDENCE_PATH" \
    --raw-result "$ARTILLERY_REPORT_PATH" \
    --availability-result "$AVAILABILITY_IMPORT_RESULT_PATH" \
    --expected-source-sha "$SOURCE_SHA" \
    --expected-tool-image "$ARTILLERY_IMAGE" \
    --max-age-seconds 300
fi
printf 'load_evidence_dir=%s\n' "$OUTPUT_DIR"
exit "$evidence_exit"
