#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == --source-context && -n "${2:-}" && "${3:-}" == --language && "${4:-}" =~ ^(javascript-typescript|python)$ && $# == 4 ]] || { echo 'Usage: run-internal-ci-codeql.sh --source-context <context.json> --language <javascript-typescript|python>' >&2; exit 64; }
context=$2; language=$4; : "${CODEQL_CLI:?}" "${CODEQL_BUNDLE_SHA256:?}"
workspace=$PWD; artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"; source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"; scan_source="$source_root/scan"; build_root="$source_root/build"; db_root="$RUNNER_TEMP/lunchlineup-codeql-$CI_RUN_ID"; output="$artifact_root/codeql"
test "$context" = "$source_root/source-context.json"; test -x "$CODEQL_CLI"; node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$scan_source" --purpose scan --require-clean >/dev/null
mkdir -p "$db_root" "$output" "$artifact_root/results" "$artifact_root/details"; started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"$CODEQL_CLI" database create "$db_root/$language" --language="$language" --source-root="$scan_source" --build-mode=none --codescanning-config="$scan_source/.github/codeql/codeql-config.yml" >"$output/$language-create.log" 2>&1
if [[ "$language" == javascript-typescript ]]; then suite='codeql/javascript-queries:codeql-suites/javascript-security-extended.qls'; else suite='codeql/python-queries:codeql-suites/python-security-extended.qls'; fi
"$CODEQL_CLI" database analyze "$db_root/$language" "$suite" --format=sarifv2.1.0 --output="$output/codeql-$language.sarif" --sarif-category="/language:$language" --download=false >"$output/$language-analyze.log" 2>&1
gate="codeql-$language"
node "$build_root/scripts/verify-internal-ci-codeql.mjs" --source-context "$context" --language "$language" --sarif "$output/codeql-$language.sarif" --bundle-sha256 "$CODEQL_BUNDLE_SHA256" --baseline "$scan_source/security/codeql-baseline.json" --details "$artifact_root/details/$gate.json"
node "$build_root/scripts/write-internal-ci-command-result.mjs" --name "$gate" --source-context "$context" --started-at "$started_at" --output "$artifact_root/results/$gate.json"
node "$build_root/scripts/record-internal-ci-gate.mjs" --name "$gate" --source-context "$context" --started-at "$started_at" --command-result "$artifact_root/results/$gate.json" --details "$artifact_root/details/$gate.json" --output "$artifact_root/gates/$gate.json" --evidence "$output/codeql-$language.sarif" --evidence "$output/$language-create.log" --evidence "$output/$language-analyze.log"
