#!/usr/bin/env bash
set -euo pipefail
umask 077

name=${1:?gate name is required}
log_relative=${2:?artifact-relative log path is required}
shift 2
workspace=$PWD
artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"
source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"
build_root="$source_root/build"
scan_root="$source_root/scan"
context="$source_root/source-context.json"
test -f "$artifact_root/source/source-proof.json"
test -d "$build_root"
test -d "$scan_root"
test -f "$context"
node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build >/dev/null
log="$artifact_root/$log_relative"
mkdir -p "$(dirname "$log")"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cd "$build_root"
"$@" >"$log" 2>&1
result="$artifact_root/results/$name.json"
details="$artifact_root/details/$name.json"
mkdir -p "$(dirname "$result")" "$(dirname "$details")"
test ! -e "$details"
umask 077
printf '{"sourceSha":"%s"}\n' "$CI_COMMIT_SHA" >"$details"
node "$build_root/scripts/write-internal-ci-command-result.mjs" --name "$name" --source-context "$context" --started-at "$started_at" --output "$result"
node "$build_root/scripts/record-internal-ci-gate.mjs" --name "$name" --source-context "$context" --started-at "$started_at" --command-result "$result" --details "$details" --output "$artifact_root/gates/$name.json" --evidence "$log"
