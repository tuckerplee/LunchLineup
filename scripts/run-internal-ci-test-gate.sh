#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == --source-context && -n "${2:-}" && "${3:-}" == --suite && "${4:-}" =~ ^(javascript|engine|worker|build)$ && $# == 4 ]] || { echo 'Usage: run-internal-ci-test-gate.sh --source-context <context.json> --suite <javascript|engine|worker|build>' >&2; exit 64; }
context=$2; suite=$4; workspace=$PWD; artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"; source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"; build_root="$source_root/build"
test "$context" = "$source_root/source-context.json"; node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build >/dev/null
case "$suite" in javascript) gate=javascript-unit;; engine) gate=engine-unit;; worker) gate=worker-unit;; build) gate=source-build;; esac
output="$artifact_root/tests/$suite"; mkdir -p "$output" "$artifact_root/results" "$artifact_root/details"; started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ); cd "$build_root"
case "$suite" in
 javascript) npx playwright install chromium >"$output/playwright-install.log" 2>&1; npx turbo run test -- --coverage >"$output/test.log" 2>&1; find . -type d -name coverage -not -path './node_modules/*' -print0 | while IFS= read -r -d '' dir; do target="$output/coverage/${dir#./}"; mkdir -p "$(dirname "$target")"; cp -R "$dir" "$target"; done;;
 engine) venv="$RUNNER_TEMP/lunchlineup-engine-venv-$CI_RUN_ID"; test ! -e "$venv"; python3 -m venv "$venv"; trap 'rm -rf -- "$venv"' EXIT; "$venv/bin/pip" install --requirement apps/engine/requirements.txt >"$output/pip.log" 2>&1; (cd apps/engine && "$venv/bin/python" -m pytest --cov=src --cov-fail-under=90 --junitxml="$output/engine-junit.xml") >"$output/test.log" 2>&1;;
 worker) venv="$RUNNER_TEMP/lunchlineup-worker-venv-$CI_RUN_ID"; test ! -e "$venv"; python3 -m venv "$venv"; trap 'rm -rf -- "$venv"' EXIT; "$venv/bin/pip" install --requirement apps/worker/requirements.txt >"$output/pip.log" 2>&1; (cd apps/worker && "$venv/bin/python" -m unittest discover -s tests) >"$output/test.log" 2>&1;;
 build) npm run build >"$output/build.log" 2>&1;;
esac
printf '{"sourceSha":"%s","suite":"%s"}\n' "$CI_COMMIT_SHA" "$suite" >"$artifact_root/details/$gate.json"
node "$build_root/scripts/write-internal-ci-command-result.mjs" --name "$gate" --source-context "$context" --started-at "$started_at" --output "$artifact_root/results/$gate.json"
evidence=(--evidence "$output/${suite/build/build}.log"); [[ -f "$output/test.log" ]] && evidence=(--evidence "$output/test.log"); [[ -f "$output/engine-junit.xml" ]] && evidence+=(--evidence "$output/engine-junit.xml"); [[ -f "$output/pip.log" ]] && evidence+=(--evidence "$output/pip.log")
node "$build_root/scripts/record-internal-ci-gate.mjs" --name "$gate" --source-context "$context" --started-at "$started_at" --command-result "$artifact_root/results/$gate.json" --details "$artifact_root/details/$gate.json" --output "$artifact_root/gates/$gate.json" "${evidence[@]}"
