#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == --source-context && -n "${2:-}" && $# == 2 ]] || { echo 'Usage: install-internal-ci-dependencies.sh --source-context <context.json>' >&2; exit 64; }
context=$2; workspace=$PWD; artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"; source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"; build_root="$source_root/build"
test "$context" = "$source_root/source-context.json"; test -f "$artifact_root/source/source-proof.json"; test -d "$build_root"
node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build --require-clean >/dev/null
mkdir -p "$artifact_root/source"
cd "$build_root"
npm ci >"$artifact_root/source/npm-ci.log" 2>&1
