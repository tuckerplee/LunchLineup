#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${1:-}" == --source-context && -n "${2:-}" && "${3:-}" == --mode && "${4:-}" =~ ^(full|delta)$ && $# == 4 ]] || { echo 'Usage: run-internal-ci-semgrep.sh --source-context <context.json> --mode <full|delta>' >&2; exit 64; }
context=$2; mode=$4; workspace=$PWD; artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"; source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"; scan_source="$source_root/scan"; build_root="$source_root/build"
test "$context" = "$source_root/source-context.json"; node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$scan_source" --purpose scan --require-clean >/dev/null
SEMGREP_IMAGE='semgrep/semgrep:1.169.0@sha256:2b33f46ba66cf8cc2ad59ccfa7d22951fd00c632c38f1339e84ec8e6e641a942'; export SEMGREP_IMAGE
output="$artifact_root/semgrep"; mkdir -p "$output" "$artifact_root/results" "$artifact_root/details"; started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
args=(semgrep scan --config p/default --metrics=off --sarif --output "/out/$mode.sarif")
source_mount_mode=ro
if [[ "$mode" == delta ]]; then baseline_sha=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(p.baselineSha)' "$artifact_root/source/source-proof.json"); args+=(--baseline-commit "$baseline_sha" --error); source_mount_mode=rw; fi
args+=(.)
docker run --rm --user 0:0 --env HOME=/tmp/semgrep-home --volume "$scan_source:/src:$source_mount_mode" --volume "$output:/out:rw" --workdir /src "$SEMGREP_IMAGE" "${args[@]}"
node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$scan_source" --purpose scan --require-clean >/dev/null
gate="semgrep-$mode"
node "$build_root/scripts/verify-internal-ci-semgrep.mjs" --source-context "$context" --mode "$mode" --scanner-image "$SEMGREP_IMAGE" --report "$output/$mode.sarif" --details "$artifact_root/details/$gate.json"
node "$build_root/scripts/write-internal-ci-command-result.mjs" --name "$gate" --source-context "$context" --started-at "$started_at" --output "$artifact_root/results/$gate.json"
node "$build_root/scripts/record-internal-ci-gate.mjs" --name "$gate" --source-context "$context" --started-at "$started_at" --command-result "$artifact_root/results/$gate.json" --details "$artifact_root/details/$gate.json" --output "$artifact_root/gates/$gate.json" --evidence "$output/$mode.sarif"
