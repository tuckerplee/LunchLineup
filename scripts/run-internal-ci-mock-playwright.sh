#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${1:-}" == --source-context && -n "${2:-}" && $# == 2 ]] || { echo 'Usage: run-internal-ci-mock-playwright.sh --source-context <context.json>' >&2; exit 64; }
context=$2; workspace=$PWD; artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"; source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"; build_root="$source_root/build"
test "$context" = "$source_root/source-context.json"; node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build >/dev/null
output="$artifact_root/mock-playwright"; mkdir -p "$output" "$artifact_root/results" "$artifact_root/details"; started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ); cd "$build_root/apps/web"
npx playwright install chromium firefox >"$output/install.log" 2>&1
E2E_FULL_STACK=0 E2E_MOCK_API=1 PLAYWRIGHT_JSON_OUTPUT_NAME="$output/results.json" npx playwright test --reporter=json >"$output/test.log" 2>&1
mapfile -t changed_paths < <(git diff --name-only)
[[ "${#changed_paths[@]}" -eq 1 && "${changed_paths[0]}" == apps/web/next-env.d.ts ]] || { printf 'Unexpected tracked mutations after mock Playwright: %s\n' "${changed_paths[*]:-(none)}" >&2; exit 1; }
node - <<'NODE'
const fs = require('node:fs');
const expected = '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\nimport "./.next/dev/types/routes.d.ts";\n\n// NOTE: This file should not be edited\n// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.\n';
if (fs.readFileSync('next-env.d.ts', 'utf8') !== expected) throw new Error('Next dev produced an unexpected next-env.d.ts mutation.');
NODE
git restore --source=HEAD -- apps/web/next-env.d.ts
node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build --require-clean >/dev/null
node - "$output/results.json" "$artifact_root/details/mock-playwright.json" "$CI_COMMIT_SHA" <<'NODE'
const fs=require('node:fs');const [reportPath,output,sourceSha]=process.argv.slice(2),report=JSON.parse(fs.readFileSync(reportPath));const stats=report.stats??{};for(const key of ['expected','skipped','unexpected','flaky'])if(!Number.isSafeInteger(stats[key])||stats[key]<0)throw new Error('Invalid Playwright JSON statistics.');if(stats.unexpected!==0)throw new Error('Mock Playwright has unexpected failures.');fs.writeFileSync(output,JSON.stringify({sourceSha,browsers:['chromium','firefox'],fullStack:false,mockApi:true,passed:stats.expected,failed:stats.unexpected,skipped:stats.skipped,flaky:stats.flaky},null,2)+'\n',{flag:'wx',mode:0o600});
NODE
node "$build_root/scripts/write-internal-ci-command-result.mjs" --name mock-playwright --source-context "$context" --started-at "$started_at" --output "$artifact_root/results/mock-playwright.json"
node "$build_root/scripts/record-internal-ci-gate.mjs" --name mock-playwright --source-context "$context" --started-at "$started_at" --command-result "$artifact_root/results/mock-playwright.json" --details "$artifact_root/details/mock-playwright.json" --output "$artifact_root/gates/mock-playwright.json" --evidence "$output/install.log" --evidence "$output/test.log" --evidence "$output/results.json"
