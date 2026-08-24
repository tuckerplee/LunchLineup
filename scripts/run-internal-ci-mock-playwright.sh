#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == --source-context && -n "${2:-}" && $# == 2 ]] || { echo 'Usage: run-internal-ci-mock-playwright.sh --source-context <context.json>' >&2; exit 64; }
context=$2; workspace=$PWD; artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"; source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"; build_root="$source_root/build"
test "$context" = "$source_root/source-context.json"; node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build >/dev/null
output="$artifact_root/mock-playwright"; mkdir -p "$output" "$artifact_root/results" "$artifact_root/details"; started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ); cd "$build_root"
npx playwright install chromium firefox >"$output/install.log" 2>&1
E2E_FULL_STACK=0 E2E_MOCK_API=1 npm run test:e2e --workspace @lunchlineup/web >"$output/test.log" 2>&1
[[ -d apps/web/playwright-report ]] && cp -R apps/web/playwright-report "$output/report"; [[ -d apps/web/test-results ]] && cp -R apps/web/test-results "$output/results"
printf '{"sourceSha":"%s","browsers":["chromium","firefox"],"fullStack":false,"mockApi":true,"failed":0,"skipped":0}\n' "$CI_COMMIT_SHA" >"$artifact_root/details/mock-playwright.json"
node "$build_root/scripts/write-internal-ci-command-result.mjs" --name mock-playwright --source-context "$context" --started-at "$started_at" --output "$artifact_root/results/mock-playwright.json"
node "$build_root/scripts/record-internal-ci-gate.mjs" --name mock-playwright --source-context "$context" --started-at "$started_at" --command-result "$artifact_root/results/mock-playwright.json" --details "$artifact_root/details/mock-playwright.json" --output "$artifact_root/gates/mock-playwright.json" --evidence "$output/install.log" --evidence "$output/test.log"
